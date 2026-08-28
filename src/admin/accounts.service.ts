import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { DOWNLOAD_URL_TTL_SECONDS } from '../media/media.constants';
import { TokenService } from '../auth/token.service';
import type { Role } from '../generated/prisma/enums';
import { AuditService } from './audit.service';
import { AccountsQueryDto, SuspendAccountDto } from './dto/accounts.dto';

const DEFAULT_PAGE_SIZE = 25;

/**
 * Who this page is about. Typed rather than inlined so Prisma reads it as the
 * enum it is — a bare array literal widens to `string[]` and the whole `where`
 * stops matching `UserWhereInput`.
 */
const ACCOUNT_ROLES: Role[] = ['ARTIST', 'LABEL'];

/**
 * The accounts behind the catalogue.
 *
 * Keyed by user id throughout, not by artist id: a LABEL account has no artist
 * row at all, and the whole reason this page exists is that a console showing
 * only artists cannot see half of who signed up.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everyone who is not an administrator.
   *
   * Admins are excluded by role rather than filtered out afterwards, so the
   * count and the pagination agree with the rows. They have their own page,
   * with rules this one does not enforce.
   */
  async list(query: AccountsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const search = query.search?.trim();

    const where = {
      role: query.role ? query.role : { in: ACCOUNT_ROLES },
      // A deleted account is anonymised in place, so its row survives with no
      // usable PII on it. Showing those would be a page of blanks.
      isDeleted: false,
      ...(query.status && { accountStatus: query.status }),
      ...(search && {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          {
            artist: {
              stageName: { contains: search, mode: 'insensitive' as const },
            },
          },
          {
            ownedLabel: {
              name: { contains: search, mode: 'insensitive' as const },
            },
          },
        ],
      }),
    };

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          image: true,
          country: true,
          role: true,
          accountStatus: true,
          accountStatusReason: true,
          emailVerified: true,
          onboardingCompleted: true,
          lastLoginAt: true,
          createdAt: true,
          artist: {
            select: {
              id: true,
              stageName: true,
              slug: true,
              _count: { select: { releases: true } },
            },
          },
          ownedLabel: {
            select: {
              id: true,
              name: true,
              slug: true,
              _count: { select: { artists: true } },
              // Only the counts, to total the label's catalogue. Cheaper than a
              // second groupBy for a page of twenty accounts.
              artists: { select: { _count: { select: { releases: true } } } },
            },
          },
        },
      }),
    ]);

    return {
      items: users.map((user) => ({
        ...user,
        // The name to show in a list. A stage name beats a legal one for an
        // artist, because it is what the catalogue is filed under.
        displayName:
          user.artist?.stageName ??
          user.ownedLabel?.name ??
          ([user.firstName, user.lastName].filter(Boolean).join(' ') ||
            user.email),
        // A label's catalogue is its roster's. Reading `user.artist` alone
        // showed every label as having nothing, the same way the detail page
        // did before roster management existed.
        releaseCount:
          user.artist?._count.releases ??
          (user.ownedLabel?.artists ?? []).reduce(
            (sum, artist) => sum + artist._count.releases,
            0,
          ),
        rosterCount: user.ownedLabel?._count.artists ?? 0,
      })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** One account, with the catalogue it has produced. */
  async findOne(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, role: { in: ACCOUNT_ROLES } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        image: true,
        phoneNumber: true,
        country: true,
        role: true,
        accountStatus: true,
        accountStatusReason: true,
        accountStatusUpdatedAt: true,
        emailVerified: true,
        onboardingCompleted: true,
        provider: true,
        acceptedTermsAt: true,
        termsVersion: true,
        isDeleted: true,
        lastLoginAt: true,
        createdAt: true,
        artist: {
          select: {
            id: true,
            stageName: true,
            slug: true,
            legalName: true,
            bio: true,
            country: true,
            createdAt: true,
          },
        },
        ownedLabel: {
          select: {
            id: true,
            name: true,
            slug: true,
            country: true,
            // The roster, and who has been let into each artist. Both are
            // invisible to the artist-shaped view above, and both are things
            // support gets asked about: "which artists does this label have"
            // and "why can this person see my catalogue".
            artists: {
              select: {
                id: true,
                stageName: true,
                slug: true,
                country: true,
                spotifyArtistId: true,
                createdAt: true,
                _count: { select: { releases: true } },
                seats: {
                  where: { status: { not: 'REVOKED' } },
                  select: {
                    id: true,
                    email: true,
                    role: true,
                    status: true,
                    acceptedAt: true,
                    createdAt: true,
                  },
                  orderBy: { createdAt: 'asc' },
                },
              },
              orderBy: { stageName: 'asc' },
            },
          },
        },
        _count: { select: { sessions: true } },
      },
    });

    if (!user) throw new NotFoundException('Account not found');

    // Releases hang off the artist row, so a label's catalogue is its roster's.
    // Reading only `user.artist` showed an empty list for every label, which was
    // right until roster management existed and silently wrong afterwards.
    const artistIds = user.artist
      ? [user.artist.id]
      : (user.ownedLabel?.artists ?? []).map((artist) => artist.id);

    const releases =
      artistIds.length > 0
        ? await this.prisma.release.findMany({
            where: { artistId: { in: artistIds } },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              title: true,
              type: true,
              status: true,
              submittedAt: true,
              reviewedAt: true,
              createdAt: true,
              artworkAsset: { select: { key: true, status: true } },
              _count: { select: { tracks: true } },
              // Which roster artist it belongs to. On an artist account this is
              // always the same name; on a label's it is the column that makes
              // the list readable.
              artist: { select: { id: true, stageName: true } },
            },
          })
        : [];

    return {
      ...user,
      displayName:
        user.artist?.stageName ??
        user.ownedLabel?.name ??
        ([user.firstName, user.lastName].filter(Boolean).join(' ') ||
          user.email),
      sessionCount: user._count.sessions,
      // Who locked this account, and who let it back in. The status field says
      // only what is true now; this says how it got there.
      history: await this.audit.forTarget('ACCOUNT', userId),
      releases: await Promise.all(
        releases.map(async (release) => ({
          id: release.id,
          title: release.title,
          type: release.type,
          status: release.status,
          submittedAt: release.submittedAt,
          reviewedAt: release.reviewedAt,
          createdAt: release.createdAt,
          trackCount: release._count.tracks,
          artist: release.artist,
          artworkUrl:
            release.artworkAsset?.status === 'UPLOADED' &&
            this.storage.isConfigured
              ? await this.storage.presignGet(
                  release.artworkAsset.key,
                  DOWNLOAD_URL_TTL_SECONDS,
                )
              : null,
        })),
      ),
    };
  }

  /**
   * Locks an account out.
   *
   * The status is checked twice on the way in — once by `validateUser` at
   * sign-in and again by `JwtStrategy` on every authenticated request — so this
   * takes effect immediately rather than at the next login. Revoking the
   * sessions as well is belt and braces, and means the refresh token cannot
   * mint a new access token in the gap.
   *
   * The reason is not internal. It is thrown back at the account holder
   * verbatim the next time they try to sign in.
   */
  async suspend(userId: string, dto: SuspendAccountDto, adminUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, accountStatus: true },
    });

    if (!user) throw new NotFoundException('Account not found');

    // Administrators are suspended from their own page, which has rules this
    // one does not — the last super admin must not be able to disappear.
    if (user.role === 'ADMIN') {
      throw new BadRequestException(
        'Administrator accounts are managed on the Administrators page',
      );
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
      adminUserId,
      action: 'ACCOUNT_SUSPENDED',
      targetType: 'ACCOUNT',
      targetId: userId,
      detail: dto.reason,
    });

    return { message: 'Account suspended.' };
  }

  /** Puts a suspended account back. Sessions are gone; they sign in again. */
  async reinstate(userId: string, adminUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, accountStatus: true, isDeleted: true },
    });

    if (!user) throw new NotFoundException('Account not found');

    if (user.role === 'ADMIN') {
      throw new BadRequestException(
        'Administrator accounts are managed on the Administrators page',
      );
    }

    // A deleted account is suspended as part of deletion and its PII is already
    // gone. Flipping the status back would leave a live login attached to an
    // anonymised row rather than restoring anything.
    if (user.isDeleted) {
      throw new BadRequestException(
        'This account was deleted by its owner and cannot be reinstated',
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        accountStatus: 'ACTIVE',
        accountStatusReason: null,
        accountStatusUpdatedAt: new Date(),
      },
    });

    await this.audit.record({
      adminUserId,
      action: 'ACCOUNT_REINSTATED',
      targetType: 'ACCOUNT',
      targetId: userId,
    });

    return { message: 'Account reinstated.' };
  }
}
