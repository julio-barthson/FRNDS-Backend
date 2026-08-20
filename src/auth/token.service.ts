import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { Role } from '../generated/prisma/enums';

export interface JwtPayload {
  sub: string; // user id
  email: string;
  role: Role;
  sid: string; // session id — lets us revoke one device without touching others
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in ms, so the app knows when to refresh. */
  expiresIn: number;
}

export interface DeviceMeta {
  deviceName?: string;
  platform?: string;
  appVersion?: string;
  ipAddress?: string;
  userAgent?: string;
}

const ACCESS_TOKEN_EXPIRY = '15m';
const ACCESS_TOKEN_EXPIRY_MS = 15 * 60 * 1000;
const REFRESH_TOKEN_EXPIRY = '30d';
const REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Issues and rotates tokens against the Session table — one row per device.
 *
 * Refresh tokens are stored as SHA-256 rather than bcrypt: the token is a
 * signed JWT with plenty of entropy, so a slow hash buys nothing and would tax
 * every refresh. The session id travels inside the token, making validation an
 * indexed primary-key lookup instead of a scan over every user's sessions.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private get accessSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set');
    return secret;
  }

  private get refreshSecret(): string {
    const secret = process.env.JWT_REFRESH_SECRET;
    if (!secret) throw new Error('JWT_REFRESH_SECRET is not set');
    return secret;
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private matches(token: string, storedHash: string): boolean {
    const a = Buffer.from(this.hash(token), 'hex');
    const b = Buffer.from(storedHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Creates a new session row and returns the token pair for it. */
  async issueSession(
    user: { id: string; email: string; role: Role },
    device: DeviceMeta = {},
  ): Promise<TokenPair> {
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: '', // replaced below, once the token exists
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
        ...device,
      },
    });

    const pair = await this.signPair({
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: session.id,
    });

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: this.hash(pair.refreshToken),
        lastUsedAt: new Date(),
      },
    });

    return pair;
  }

  /**
   * Verifies a refresh token and rotates it. Returns null on anything
   * suspicious so the caller can respond with a clean 401.
   */
  async rotate(
    refreshToken: string,
    device: DeviceMeta = {},
  ): Promise<{ pair: TokenPair; userId: string } | null> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      return null; // expired, tampered, or signed with the wrong secret
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            isDeleted: true,
            accountStatus: true,
          },
        },
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt < new Date() ||
      session.user.isDeleted ||
      session.user.accountStatus !== 'ACTIVE'
    ) {
      return null;
    }

    if (!this.matches(refreshToken, session.refreshTokenHash)) {
      // The token is validly signed but is not the current one for this
      // session — a replay of a token we already rotated away. Assume theft and
      // kill the session.
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    const pair = await this.signPair({
      sub: session.user.id,
      email: session.user.email,
      role: session.user.role,
      sid: session.id,
    });

    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: this.hash(pair.refreshToken),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
        ...device,
      },
    });

    return { pair, userId: session.user.id };
  }

  /** Revokes the single session a refresh token belongs to (normal logout). */
  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    let payload: JwtPayload;
    try {
      // Expired tokens still identify their session, and logging out after a
      // long idle period must still work.
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret,
        ignoreExpiration: true,
      });
    } catch {
      return; // malformed — nothing to revoke
    }

    await this.prisma.session.updateMany({
      where: { id: payload.sid, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Signs every device out — used on password change and account deletion. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        deviceName: true,
        platform: true,
        appVersion: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new UnauthorizedException('Session not found');
    }
  }

  private async signPair(payload: JwtPayload): Promise<TokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.accessSecret,
        expiresIn: ACCESS_TOKEN_EXPIRY,
      }),
      this.jwt.signAsync(payload, {
        secret: this.refreshSecret,
        expiresIn: REFRESH_TOKEN_EXPIRY,
      }),
    ]);

    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRY_MS };
  }

  static get refreshTokenTtlMs(): number {
    return REFRESH_TOKEN_EXPIRY_MS;
  }
}
