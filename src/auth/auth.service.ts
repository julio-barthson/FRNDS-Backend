import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { randomInt } from 'node:crypto';
import slugify from 'slugify';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import {
  accountDeletedTemplate,
  passwordChangedTemplate,
  passwordResetTemplate,
  verifyEmailTemplate,
  welcomeTemplate,
} from '../mail/templates';
import { notDeleted } from '../utils/prismaFilters';
import { AccountTypeDto } from './dto/account-type.dto';
import { RegisterUserDto } from './dto/register-user.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  toUserResponse,
  userResponseSelect,
  UserResponseDto,
} from './dto/user-response.dto';
import { DeviceMeta, TokenPair, TokenService } from './token.service';

const OTP_TTL_MS = 10 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

/** Bump when the artist-facing terms change; stored per account at signup. */
export const CURRENT_TERMS_VERSION = '2026-08-v1';

export interface AuthSession extends TokenPair {
  user: UserResponseDto;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Verification only — no client id or secret needed here, since the audience
   * is supplied per call and the app performs the sign-in itself.
   */
  private readonly googleClient = new OAuth2Client();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly tokens: TokenService,
  ) {}

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Creates the login only. The profile row behind it — an artist, or a label
   * with a roster — is chosen on the first onboarding step, because a Google
   * sign-in hands back a session before anything has been asked and both
   * signup paths have to converge somewhere. See {@link setAccountType}.
   */
  async register(dto: RegisterUserDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const email = dto.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with that email already exists');
    }

    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const { otp, hashedOTP, expiry } = await this.generateOtp();

    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        phoneNumber: dto.phoneNumber,
        country: dto.country.toUpperCase(),
        acceptedTermsAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        emailVerificationOTP: hashedOTP,
        emailVerificationOTPExpiry: expiry,
      },
      select: { email: true },
    });

    await this.mail.sendMail({
      toEmail: user.email,
      subject: 'Your FRNDSHQ verification code',
      html: verifyEmailTemplate('', otp),
    });

    return {
      email: user.email,
      message: 'Account created. Check your email for a verification code.',
    };
  }

  // ── Email verification ────────────────────────────────────────────────────

  async sendEmailVerificationOTP(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email, ...notDeleted() },
      select: {
        email: true,
        emailVerified: true,
        artist: { select: { stageName: true } },
      },
    });

    // Same response either way: a differing message would let anyone probe
    // which email addresses have accounts.
    const genericResponse = {
      message:
        'If that email has an account, a verification code is on its way.',
    };

    if (!user || user.emailVerified) return genericResponse;

    const { otp, hashedOTP, expiry } = await this.generateOtp();

    await this.prisma.user.update({
      where: { email },
      data: {
        emailVerificationOTP: hashedOTP,
        emailVerificationOTPExpiry: expiry,
      },
    });

    await this.mail.sendMail({
      toEmail: email,
      toName: user.artist?.stageName,
      subject: 'Your FRNDSHQ verification code',
      html: verifyEmailTemplate(user.artist?.stageName ?? '', otp),
    });

    return genericResponse;
  }

  /** Confirms the code and signs the artist straight in. */
  async verifyEmailOTP(
    rawEmail: string,
    otp: string,
    device: DeviceMeta,
  ): Promise<AuthSession> {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email, ...notDeleted() },
      select: {
        id: true,
        email: true,
        role: true,
        emailVerified: true,
        emailVerificationOTP: true,
        emailVerificationOTPExpiry: true,
        artist: { select: { stageName: true } },
      },
    });

    if (!user) throw new NotFoundException('No account with that email');
    if (user.emailVerified) {
      throw new BadRequestException('Email is already verified');
    }
    if (!user.emailVerificationOTP || !user.emailVerificationOTPExpiry) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    if (user.emailVerificationOTPExpiry < new Date()) {
      throw new UnauthorizedException('Verification code has expired');
    }
    if (!(await bcrypt.compare(otp, user.emailVerificationOTP))) {
      throw new UnauthorizedException('Invalid verification code');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationOTP: null,
        emailVerificationOTPExpiry: null,
      },
    });

    await this.mail.sendMail({
      toEmail: user.email,
      toName: user.artist?.stageName,
      subject: 'Welcome to FRNDSHQ',
      html: welcomeTemplate(user.artist?.stageName ?? ''),
    });

    return this.startSession(user.id, device);
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  /** Used by the local Passport strategy. Returns null on bad credentials. */
  async validateUser(rawEmail: string, password: string) {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email, ...notDeleted() },
      select: {
        id: true,
        email: true,
        password: true,
        role: true,
        accountStatus: true,
        accountStatusReason: true,
      },
    });

    if (!user) return null;

    if (!user.password) {
      throw new UnauthorizedException(
        'This account has no password set. Reset your password to sign in.',
      );
    }

    if (!(await bcrypt.compare(password, user.password))) return null;

    this.assertAccountUsable(user.accountStatus, user.accountStatusReason);

    return { id: user.id, email: user.email, role: user.role };
  }

  async login(user: { id: string }, device: DeviceMeta): Promise<AuthSession> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return this.startSession(user.id, device);
  }

  // ── Account type ──────────────────────────────────────────────────────────

  /**
   * Creates the profile row behind a login — an artist, or a label with a
   * roster.
   *
   * This is the first onboarding step rather than part of signup because a
   * Google sign-in produces a session before anything has been asked, so both
   * signup paths have to meet here. Until it runs the account has no profile
   * at all, which is safe: `onboardingCompleted` is false, and every catalogue
   * route resolves ownership through a profile row that does not yet exist.
   *
   * Re-callable while onboarding is unfinished, so a wrong choice can be
   * corrected. Once finished it is closed: releases hang off the profile row,
   * and swapping it then would be a data migration, not a preference.
   */
  async setAccountType(userId: string, dto: AccountTypeDto) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted() },
      select: {
        id: true,
        onboardingCompleted: true,
        artist: { select: { id: true } },
        ownedLabel: { select: { id: true } },
      },
    });

    if (!user) throw new NotFoundException('Account not found');

    const existing = user.artist ?? user.ownedLabel;
    if (user.onboardingCompleted && existing) {
      throw new ConflictException(
        'Your account type is already set and cannot be changed here.',
      );
    }

    const name = dto.name.trim();

    await this.prisma.$transaction(async (tx) => {
      // Nothing can reference these yet — the catalogue is gated behind
      // onboarding — so replacing the row outright is safe.
      if (user.artist) await tx.artist.delete({ where: { id: user.artist.id } });
      if (user.ownedLabel) {
        await tx.label.delete({ where: { id: user.ownedLabel.id } });
      }

      if (dto.accountType === 'LABEL') {
        await tx.label.create({
          data: { ownerId: userId, name, slug: await this.uniqueLabelSlug(name) },
        });
        await tx.user.update({
          where: { id: userId },
          data: { role: 'LABEL' },
        });
        return;
      }

      await tx.artist.create({
        data: {
          userId,
          stageName: name,
          slug: await this.uniqueArtistSlug(name),
        },
      });
      await tx.user.update({ where: { id: userId }, data: { role: 'ARTIST' } });
    });

    return this.findUserById(userId);
  }

  // ── Google ────────────────────────────────────────────────────────────────

  /**
   * Google hands out a different `aud` depending on which OAuth client started
   * the flow, and a native app needs one client id per platform. All of them
   * are accepted here, comma-separated, so Android, iOS and web can share this
   * endpoint.
   */
  private get googleAudiences(): string[] {
    return (process.env.GOOGLE_CLIENT_ID ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  private async verifyGoogleIdToken(idToken: string) {
    const audience = this.googleAudiences;
    if (audience.length === 0) {
      this.logger.error('GOOGLE_CLIENT_ID is not set — cannot verify ID tokens');
      throw new BadRequestException('Google sign-in is not available.');
    }

    let payload: TokenPayload | undefined;
    try {
      // `verifyIdToken` checks the signature against Google's rotating public
      // keys and asserts issuer, audience and expiry. Anything it dislikes
      // throws, so a failure here means the token is not trustworthy.
      const ticket = await this.googleClient.verifyIdToken({ idToken, audience });
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.warn(
        `Rejected Google ID token: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('Could not verify your Google account.');
    }

    if (!payload?.email || !payload.sub) {
      throw new UnauthorizedException('Google did not return an email address.');
    }

    // Without this an attacker could register any address at an identity
    // provider that does not verify ownership and take over the local account
    // of the same name below.
    if (!payload.email_verified) {
      throw new UnauthorizedException(
        'Your Google email address is not verified.',
      );
    }

    return payload;
  }

  /**
   * Signs in with a Google ID token, creating the account on first use.
   *
   * Unlike {@link register} this returns a session immediately: Google has
   * already proven the address, so there is no OTP to confirm.
   */
  async loginWithGoogle(
    idToken: string,
    device: DeviceMeta,
  ): Promise<AuthSession> {
    const payload = await this.verifyGoogleIdToken(idToken);

    const email = payload.email!.trim().toLowerCase();
    const googleId = payload.sub;

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ googleId }, { email }], ...notDeleted() },
      select: {
        id: true,
        googleId: true,
        emailVerified: true,
        accountStatus: true,
        accountStatusReason: true,
      },
    });

    if (existing) {
      this.assertAccountUsable(
        existing.accountStatus,
        existing.accountStatusReason,
      );

      await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          // Links a pre-existing password account to Google on first use. Safe
          // only because the address was verified above.
          googleId: existing.googleId ?? googleId,
          // Signing in through Google proves the address either way, which
          // also rescues an account that never confirmed its OTP.
          emailVerified: true,
          image: payload.picture ?? undefined,
          lastLoginAt: new Date(),
        },
      });

      return this.startSession(existing.id, device);
    }

    // No profile row yet: Google cannot say whether this is an artist or a
    // label, so onboarding asks. `onboardingCompleted` stays false, which is
    // what keeps the catalogue out of reach until the row exists.
    const created = await this.prisma.user.create({
      data: {
        email,
        googleId,
        provider: 'google',
        emailVerified: true,
        firstName: payload.given_name ?? null,
        lastName: payload.family_name ?? null,
        image: payload.picture ?? null,
        // The app shows the terms next to the Google button, so consent is
        // given at the same moment as with a password signup.
        acceptedTermsAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        lastLoginAt: new Date(),
      },
      select: { id: true, email: true, firstName: true },
    });

    await this.mail.sendMail({
      toEmail: created.email,
      toName: created.firstName ?? undefined,
      subject: 'Welcome to FRNDSHQ',
      html: welcomeTemplate(created.firstName ?? ''),
    });

    return this.startSession(created.id, device);
  }

  async refresh(refreshToken: string, device: DeviceMeta) {
    const rotated = await this.tokens.rotate(refreshToken, device);
    if (!rotated) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: rotated.userId },
      select: userResponseSelect,
    });

    if (!user) return null;

    return { ...rotated.pair, user: toUserResponse(user) };
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.tokens.revokeByRefreshToken(refreshToken);
    }
    return { message: "You've been logged out" };
  }

  async logoutAll(userId: string) {
    await this.tokens.revokeAllForUser(userId);
    return { message: 'Signed out on all devices' };
  }

  // ── Password reset ────────────────────────────────────────────────────────

  async sendPasswordResetOTP(rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email, ...notDeleted() },
      select: { email: true, artist: { select: { stageName: true } } },
    });

    const genericResponse = {
      message: 'If that email has an account, a reset code is on its way.',
    };

    if (!user) return genericResponse;

    const { otp, hashedOTP, expiry } = await this.generateOtp();

    await this.prisma.user.update({
      where: { email },
      data: { resetOTP: hashedOTP, resetOTPExpiry: expiry },
    });

    await this.mail.sendMail({
      toEmail: email,
      toName: user.artist?.stageName,
      subject: 'Your FRNDSHQ password reset code',
      html: passwordResetTemplate(user.artist?.stageName ?? '', otp),
    });

    return genericResponse;
  }

  /** Checks a reset code without consuming it, so the app can gate a screen. */
  async verifyResetCode(rawEmail: string, otp: string) {
    await this.assertValidResetOtp(rawEmail.trim().toLowerCase(), otp);
    return { message: 'Code verified' };
  }

  async setNewPassword(args: {
    email: string;
    otp: string;
    newPassword: string;
    confirmPassword: string;
  }) {
    if (args.newPassword !== args.confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const email = args.email.trim().toLowerCase();
    const user = await this.assertValidResetOtp(email, args.otp);

    const hashed = await bcrypt.hash(args.newPassword, BCRYPT_ROUNDS);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        resetOTP: null,
        resetOTPExpiry: null,
        mustChangePassword: false,
        // Receiving the code proves control of the address, so an unverified
        // account that resets its password is verified by the same act.
        emailVerified: true,
      },
    });

    // A reset is the recovery path after a compromise: every existing device
    // has to sign in again.
    await this.tokens.revokeAllForUser(user.id);

    await this.mail.sendMail({
      toEmail: email,
      toName: user.stageName ?? undefined,
      subject: 'Your FRNDSHQ password was changed',
      html: passwordChangedTemplate(user.stageName ?? ''),
    });

    return { message: 'Password reset successfully. Please sign in.' };
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ) {
    if (newPassword !== confirmPassword) {
      throw new BadRequestException('Passwords do not match');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        password: true,
        artist: { select: { stageName: true } },
      },
    });

    if (!user) throw new NotFoundException('User not found');
    if (!user.password) {
      throw new BadRequestException(
        'This account has no password set. Use the reset flow instead.',
      );
    }
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed, mustChangePassword: false },
    });

    await this.tokens.revokeAllForUser(userId);

    await this.mail.sendMail({
      toEmail: user.email,
      toName: user.artist?.stageName,
      subject: 'Your FRNDSHQ password was changed',
      html: passwordChangedTemplate(user.artist?.stageName ?? ''),
    });

    return { message: 'Password changed. Please sign in again.' };
  }

  // ── Profile ───────────────────────────────────────────────────────────────

  async findUserById(id: string): Promise<UserResponseDto> {
    const user = await this.prisma.user.findFirst({
      where: { id, ...notDeleted() },
      select: userResponseSelect,
    });

    if (!user) throw new NotFoundException('User not found');
    return toUserResponse(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const artist = await this.prisma.artist.findUnique({
      where: { userId },
      select: { id: true, stageName: true },
    });

    // Exactly one of these exists per account, and a nested update against the
    // missing side throws rather than being ignored.
    const label = await this.prisma.label.findUnique({
      where: { ownerId: userId },
      select: { id: true },
    });

    // Renaming changes the public slug, which has to stay unique.
    const slug =
      dto.stageName && artist && dto.stageName.trim() !== artist.stageName
        ? await this.uniqueArtistSlug(dto.stageName)
        : undefined;

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
        ...(dto.phoneNumber !== undefined && {
          phoneNumber: dto.phoneNumber,
          // A new number is unverified again, whenever we add SMS.
          phoneVerified: false,
        }),
        ...(dto.country !== undefined && {
          country: dto.country.toUpperCase(),
        }),
        ...(dto.isComplete === true && { onboardingCompleted: true }),
        // A label account has no artist row; its country lives on the label.
        ...(label &&
          dto.country !== undefined && {
            ownedLabel: { update: { country: dto.country.toUpperCase() } },
          }),
        ...(artist && {
          artist: {
            update: {
              ...(dto.stageName !== undefined && {
                stageName: dto.stageName.trim(),
              }),
              ...(slug && { slug }),
              ...(dto.legalName !== undefined && { legalName: dto.legalName }),
              ...(dto.bio !== undefined && { bio: dto.bio }),
              ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
              ...(dto.country !== undefined && {
                country: dto.country.toUpperCase(),
              }),
            },
          },
        }),
      },
      select: userResponseSelect,
    });

    return toUserResponse(user);
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  listSessions(userId: string) {
    return this.tokens.listSessions(userId);
  }

  revokeSession(userId: string, sessionId: string) {
    return this.tokens.revokeSession(userId, sessionId);
  }

  // ── Account deletion ──────────────────────────────────────────────────────

  /**
   * Soft-deletes the account: PII is anonymised immediately, sessions are
   * revoked, and the row stays behind so uploads and any future royalty
   * records keep a valid owner reference. A scheduled job removes the S3
   * objects and the row itself once the retention window passes.
   */
  async deleteAccount(userId: string, password?: string, reason?: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, ...notDeleted() },
      select: {
        id: true,
        email: true,
        password: true,
        artist: { select: { id: true, stageName: true } },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    if (user.password) {
      if (!password) {
        throw new BadRequestException(
          'Enter your password to confirm account deletion',
        );
      }
      if (!(await bcrypt.compare(password, user.password))) {
        throw new BadRequestException('Password is incorrect');
      }
    }

    const stageName = user.artist?.stageName ?? '';
    const deletedAt = new Date();
    // Keeping the row unique-safe: the real address is freed up for reuse.
    const tombstoneEmail = `deleted+${user.id}@frndshq.invalid`;

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          isDeleted: true,
          deletedAt,
          accountStatus: 'SUSPENDED',
          accountStatusReason: reason?.slice(0, 500) ?? 'Deleted by user',
          accountStatusUpdatedAt: deletedAt,
          email: tombstoneEmail,
          password: null,
          phoneNumber: null,
          firstName: null,
          lastName: null,
          middleName: null,
          image: null,
          googleId: null,
          resetOTP: null,
          resetOTPExpiry: null,
          emailVerificationOTP: null,
          emailVerificationOTPExpiry: null,
        },
      }),
      this.prisma.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: deletedAt },
      }),
    ]);

    // Send to the real address, not the tombstone.
    await this.mail.sendMail({
      toEmail: user.email,
      toName: stageName,
      subject: 'Your FRNDSHQ account has been deleted',
      html: accountDeletedTemplate(stageName),
    });

    this.logger.log(`Account ${user.id} deleted by user`);

    return { message: 'Your account has been deleted' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async startSession(
    userId: string,
    device: DeviceMeta,
  ): Promise<AuthSession> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: userResponseSelect,
    });

    const pair = await this.tokens.issueSession(
      { id: user.id, email: user.email, role: user.role },
      device,
    );

    return { ...pair, user: toUserResponse(user) };
  }

  private assertAccountUsable(status: string, reason?: string | null) {
    if (status === 'BANNED') {
      throw new ForbiddenException(
        reason ??
          'Your account has been permanently banned. Please contact support.',
      );
    }
    if (status === 'SUSPENDED') {
      throw new ForbiddenException(
        reason ??
          'Your account has been temporarily suspended. Please contact support.',
      );
    }
  }

  /** Cryptographically random 6-digit code — Math.random is guessable. */
  private async generateOtp() {
    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    return {
      otp,
      hashedOTP: await bcrypt.hash(otp, BCRYPT_ROUNDS),
      expiry: new Date(Date.now() + OTP_TTL_MS),
    };
  }

  private async assertValidResetOtp(email: string, otp: string) {
    const user = await this.prisma.user.findFirst({
      where: { email, ...notDeleted() },
      select: {
        id: true,
        resetOTP: true,
        resetOTPExpiry: true,
        artist: { select: { stageName: true } },
      },
    });

    if (!user || !user.resetOTP || !user.resetOTPExpiry) {
      throw new UnauthorizedException('Invalid or expired code');
    }
    if (user.resetOTPExpiry < new Date()) {
      throw new UnauthorizedException('Code has expired');
    }
    if (!(await bcrypt.compare(otp, user.resetOTP))) {
      throw new UnauthorizedException('Invalid code');
    }

    return { id: user.id, stageName: user.artist?.stageName ?? null };
  }

  /** "Burna Boy" → "burna-boy", "burna-boy-2" if taken. */
  private async uniqueLabelSlug(name: string): Promise<string> {
    const base = slugify(name, { lower: true, strict: true }) || 'label';

    let slug = base;
    let counter = 1;
    while (await this.prisma.label.findUnique({ where: { slug } })) {
      counter += 1;
      slug = `${base}-${counter}`;
    }
    return slug;
  }

  private async uniqueArtistSlug(stageName: string): Promise<string> {
    const base = slugify(stageName, { lower: true, strict: true }) || 'artist';

    let slug = base;
    let counter = 1;
    while (await this.prisma.artist.findUnique({ where: { slug } })) {
      counter += 1;
      slug = `${base}-${counter}`;
    }
    return slug;
  }
}
