import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from '../auth/token.service';
import { AuditService } from './audit.service';
import {
  CreateAdminDto,
  SuspendAdminDto,
  UpdateAdminDto,
} from './dto/admins.dto';

const BCRYPT_ROUNDS = 10;

/**
 * No look-alikes — this password is read off a screen and typed by hand once,
 * so an l that might be a 1 is a support ticket.
 */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';

/**
 * A password the console shows once and never again.
 *
 * 14 characters from a 57-symbol alphabet, with a digit forced into a random
 * position so it always satisfies the letter-and-digit rule the change-password
 * DTO enforces — generating something the account holder then cannot replace
 * with anything similar would be a poor first impression.
 *
 * `randomBytes` rather than `Math.random`: this is a credential.
 */
function generatePassword(): string {
  const alphabet = LETTERS + DIGITS;
  const bytes = randomBytes(14);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);

  const digitBytes = randomBytes(2);
  chars[digitBytes[0] % chars.length] = DIGITS[digitBytes[1] % DIGITS.length];

  return chars.join('');
}

/**
 * Administrators, and who is allowed to be one.
 *
 * Every route here is `SUPER_ADMIN` only. The rules in this service are the
 * ones that stop the console being locked out of itself, and they are enforced
 * here rather than in the UI because the UI is not the authority.
 */
@Injectable()
export class AdminsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  private readonly selection = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    image: true,
    accountStatus: true,
    accountStatusReason: true,
    mustChangePassword: true,
    lastLoginAt: true,
    createdAt: true,
    admin: { select: { id: true, position: true, createdAt: true } },
  };

  private shape(user: {
    firstName: string | null;
    lastName: string | null;
    email: string;
    admin: { position: string } | null;
  }) {
    return {
      ...user,
      position: user.admin?.position ?? null,
      displayName:
        [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
    };
  }

  async list() {
    // Every admin on one page, no paging. This is a list of colleagues, not a
    // catalogue — if it ever needs pagination something has gone wrong.
    const users = await this.prisma.user.findMany({
      where: { role: 'ADMIN', isDeleted: false },
      orderBy: { createdAt: 'asc' },
      select: this.selection,
    });

    // Who let each of them in. One query for the whole page rather than one
    // per row — and the first admin has no row here at all, because they came
    // from `scripts/create-admin.cjs` before there was anyone to record.
    const created = await this.prisma.adminAction
      .findMany({
        where: {
          action: 'ADMIN_CREATED',
          targetType: 'ADMIN',
          targetId: { in: users.map((user) => user.id) },
        },
        select: {
          targetId: true,
          createdAt: true,
          admin: { select: { firstName: true, lastName: true, email: true } },
        },
      })
      // Soft, like every other read of this table — see AuditService.
      .catch(() => []);

    const addedBy = new Map<string, string>();
    for (const row of created) {
      addedBy.set(
        row.targetId,
        [row.admin.firstName, row.admin.lastName].filter(Boolean).join(' ') ||
          row.admin.email,
      );
    }

    return {
      items: users.map((user) => ({
        ...this.shape(user),
        addedBy: addedBy.get(user.id) ?? null,
      })),
    };
  }

  /**
   * Creates an administrator and returns their password once.
   *
   * The password is generated here, hashed before it touches the database, and
   * returned in this one response — there is no way to read it back afterwards,
   * only to reset it. That is deliberate: an emailed invite would be the nicer
   * flow, but the sender domain does not resolve yet, so an invite would be a
   * credential sent into a void.
   *
   * `emailVerified` is set because a person with console access was vouched for
   * by whoever created them; making them prove an address they were reached at
   * out of band adds nothing.
   */
  async create(dto: CreateAdminDto, adminUserId: string) {
    const email = dto.email.trim().toLowerCase();

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });

    if (existing) {
      throw new ConflictException(
        existing.role === 'ADMIN'
          ? 'That email already belongs to an administrator'
          : 'That email already belongs to an artist or label account',
      );
    }

    const password = generatePassword();

    const user = await this.prisma.user.create({
      data: {
        email,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: 'ADMIN',
        emailVerified: true,
        // Nothing to onboard — the artist onboarding flow is not theirs.
        onboardingCompleted: true,
        // They did not choose this password, so they cannot keep it.
        mustChangePassword: true,
        admin: { create: { position: dto.position } },
      },
      select: this.selection,
    });

    await this.audit.record({
      adminUserId,
      action: 'ADMIN_CREATED',
      targetType: 'ADMIN',
      targetId: user.id,
      detail: `Created as ${dto.position}`,
    });

    return {
      admin: this.shape(user),
      // Shown once, by the console, to the person who created them.
      password,
    };
  }

  /**
   * Changes what an administrator can do.
   *
   * Two things are refused: changing your own position, and removing the last
   * super admin. The first is not a trust question — it is that the only person
   * who can undo the mistake is the person making it. The second is how a
   * console becomes unadministrable.
   */
  async update(userId: string, dto: UpdateAdminDto, actingUserId: string) {
    if (userId === actingUserId) {
      throw new BadRequestException(
        'You cannot change your own position. Ask another super admin.',
      );
    }

    const target = await this.findAdmin(userId);

    if (dto.position && dto.position !== target.admin?.position) {
      if (target.admin?.position === 'SUPER_ADMIN') {
        await this.assertNotLastSuperAdmin(userId);
      }

      const previous = target.admin?.position ?? 'none';

      await this.prisma.admin.update({
        where: { userId },
        data: { position: dto.position },
      });

      await this.audit.record({
        adminUserId: actingUserId,
        action: 'ADMIN_POSITION_CHANGED',
        targetType: 'ADMIN',
        targetId: userId,
        detail: `${previous} → ${dto.position}`,
      });

      // The position rides on the access token's user record, which
      // `JwtStrategy` reloads per request — but a demotion should not wait even
      // that long to bite, and a promotion is worth a fresh sign-in too.
      await this.tokens.revokeAllForUser(userId);
    }

    const updated = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: this.selection,
    });

    return this.shape(updated);
  }

  /**
   * Issues a new password for an administrator who has lost theirs.
   *
   * The same one-time hand-off as creation, for the same reason: the reset
   * email cannot be delivered yet.
   */
  async resetPassword(userId: string, actingUserId: string) {
    if (userId === actingUserId) {
      throw new BadRequestException(
        'Change your own password from your account instead.',
      );
    }

    await this.findAdmin(userId);

    const password = generatePassword();

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: await bcrypt.hash(password, BCRYPT_ROUNDS),
        mustChangePassword: true,
      },
    });

    // Whoever might be holding the old credential is signed out with it.
    await this.tokens.revokeAllForUser(userId);

    await this.audit.record({
      adminUserId: actingUserId,
      action: 'ADMIN_PASSWORD_RESET',
      targetType: 'ADMIN',
      targetId: userId,
    });

    return { password };
  }

  async suspend(userId: string, dto: SuspendAdminDto, actingUserId: string) {
    if (userId === actingUserId) {
      throw new BadRequestException('You cannot suspend yourself.');
    }

    const target = await this.findAdmin(userId);

    if (target.admin?.position === 'SUPER_ADMIN') {
      await this.assertNotLastSuperAdmin(userId);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        accountStatus: 'SUSPENDED',
        accountStatusReason: dto.reason.trim(),
        accountStatusUpdatedAt: new Date(),
      },
    });

    await this.tokens.revokeAllForUser(userId);

    await this.audit.record({
      adminUserId: actingUserId,
      action: 'ADMIN_SUSPENDED',
      targetType: 'ADMIN',
      targetId: userId,
      detail: dto.reason,
    });

    return { message: 'Administrator suspended.' };
  }

  async reinstate(userId: string, actingUserId: string) {
    await this.findAdmin(userId);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        accountStatus: 'ACTIVE',
        accountStatusReason: null,
        accountStatusUpdatedAt: new Date(),
      },
    });

    await this.audit.record({
      adminUserId: actingUserId,
      action: 'ADMIN_REINSTATED',
      targetType: 'ADMIN',
      targetId: userId,
    });

    return { message: 'Administrator reinstated.' };
  }

  private async findAdmin(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, role: 'ADMIN', isDeleted: false },
      select: { ...this.selection, id: true },
    });

    if (!user) throw new NotFoundException('Administrator not found');
    return user;
  }

  /**
   * Refuses to remove the last way back in.
   *
   * Counted over accounts that could actually sign in — a suspended super admin
   * is not a fallback, it is a second lockout.
   */
  private async assertNotLastSuperAdmin(userId: string) {
    const others = await this.prisma.user.count({
      where: {
        id: { not: userId },
        role: 'ADMIN',
        isDeleted: false,
        accountStatus: 'ACTIVE',
        admin: { position: 'SUPER_ADMIN' },
      },
    });

    if (others === 0) {
      throw new BadRequestException(
        'This is the only active super admin. Promote someone else first.',
      );
    }
  }
}
