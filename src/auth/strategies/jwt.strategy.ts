import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { JwtPayload } from '../token.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set');

    super({
      jwtFromRequest: (req: Request) => {
        const auth = req?.headers?.authorization;
        if (auth?.startsWith('Bearer ')) return auth.slice(7);
        // Cookie fallback for the future web dashboard.
        const cookies = req?.cookies as Record<string, string> | undefined;
        return cookies?.accessToken ?? null;
      },
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * Runs on every authenticated request. It costs one indexed query, and buys
   * the ability to cut off a banned, deleted, or signed-out account inside 15
   * minutes instead of waiting for the access token to expire.
   */
  async validate(payload: JwtPayload) {
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: {
        revokedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            isDeleted: true,
            accountStatus: true,
            admin: { select: { position: true } },
          },
        },
      },
    });

    if (!session || session.revokedAt) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    const { user } = session;
    if (user.isDeleted) throw new UnauthorizedException('Account not found');
    if (user.accountStatus !== 'ACTIVE') {
      throw new UnauthorizedException('Account is not active');
    }

    // Becomes request.user — shaped like JwtPayload so @CurrentUser('sub')
    // works the same whether it came from the token or this lookup.
    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: payload.sid,
      adminPosition: user.admin?.position ?? null,
    };
  }
}
