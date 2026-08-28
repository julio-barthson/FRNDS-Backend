import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { DOWNLOAD_URL_TTL_SECONDS } from '../media/media.constants';
import { displayArtist } from '../catalogue/billing';
import { releaseInclude, toReleaseDetail } from '../catalogue/release.mapper';
import type { ReleaseStatus } from '../generated/prisma/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from './audit.service';
import { QueueQueryDto, RejectReleaseDto } from './dto/review.dto';

const DEFAULT_PAGE_SIZE = 20;

/** What an unfiltered queue means: everything waiting on a human. */
const QUEUE_STATUSES: ReleaseStatus[] = ['SUBMITTED', 'IN_REVIEW'];

/**
 * Statuses a review can move a release out of.
 *
 * A DRAFT has not been submitted and a READY one has already been through, so
 * neither is a decision to make. Re-reviewing a REJECTED release is not allowed
 * either — the artist edits it, which moves it back to DRAFT and then to
 * SUBMITTED again, so it re-enters the queue on its own.
 */
const REVIEWABLE: ReleaseStatus[] = ['SUBMITTED', 'IN_REVIEW'];

@Injectable()
export class ReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The queue, or the whole catalogue.
   *
   * In `queue` scope this is oldest first, which is the opposite of the
   * artist's own list — a review queue is a queue, and the release that has
   * waited longest is the one to pick up next. In `catalogue` scope it is
   * newest first and unfiltered, because that list is an archive being browsed
   * rather than a worklist being worked, and half its rows are drafts with no
   * `submittedAt` to sort on at all.
   */
  async queue(query: QueueQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const search = query.search?.trim();
    const scope = query.scope ?? 'queue';

    const where = {
      // An explicit status always wins. Without one the scope decides, and in
      // `catalogue` that means no status clause at all.
      ...(query.status
        ? { status: query.status }
        : scope === 'queue'
          ? { status: { in: QUEUE_STATUSES } }
          : {}),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' as const } },
          {
            artist: {
              stageName: { contains: search, mode: 'insensitive' as const },
            },
          },
          {
            tracks: {
              some: {
                title: { contains: search, mode: 'insensitive' as const },
              },
            },
          },
        ],
      }),
    };

    const [total, releases] = await Promise.all([
      this.prisma.release.count({ where }),
      this.prisma.release.findMany({
        where,
        orderBy:
          scope === 'queue'
            ? { submittedAt: 'asc' as const }
            : { createdAt: 'desc' as const },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          title: true,
          type: true,
          status: true,
          submittedAt: true,
          reviewedAt: true,
          createdAt: true,
          artist: {
            select: {
              id: true,
              stageName: true,
              label: { select: { id: true, name: true } },
            },
          },
          artworkAsset: { select: { key: true, status: true } },
          contributors: {
            where: { role: 'PRIMARY_ARTIST' },
            orderBy: { position: 'asc' },
            select: { name: true, role: true, position: true },
          },
          _count: { select: { tracks: true } },
        },
      }),
    ]);

    const items = await Promise.all(
      releases.map(async (release) => ({
        id: release.id,
        title: release.title,
        type: release.type,
        status: release.status,
        submittedAt: release.submittedAt,
        // Null until someone has decided. The catalogue list shows it in place
        // of a waiting time, which stops meaning anything once a release is
        // off the queue.
        reviewedAt: release.reviewedAt,
        createdAt: release.createdAt,
        trackCount: release._count.tracks,
        // Who owns the account, which is not always who it is billed to.
        artist: release.artist,
        displayArtist: displayArtist(release.contributors),
        // Waiting time is the whole reason this list is sorted the way it is,
        // so it is computed here rather than left to the client's clock.
        waitingHours: release.submittedAt
          ? Math.floor(
              (Date.now() - release.submittedAt.getTime()) / (1000 * 60 * 60),
            )
          : null,
        artworkUrl:
          release.artworkAsset?.status === 'UPLOADED' &&
          this.storage.isConfigured
            ? await this.storage.presignGet(
                release.artworkAsset.key,
                DOWNLOAD_URL_TTL_SECONDS,
              )
            : null,
      })),
    );

    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /**
   * One release, in full, for the person deciding on it.
   *
   * Reuses the artist-facing mapper deliberately — the reviewer has to see
   * exactly what the artist sees, including the composed display title and the
   * signed audio URLs, or the two are arguing about different things. The only
   * difference is that this is not scoped to an owner.
   */
  async findOne(releaseId: string) {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      include: {
        ...releaseInclude,
        artist: {
          select: {
            id: true,
            stageName: true,
            legalName: true,
            country: true,
            user: { select: { id: true, email: true, createdAt: true } },
            // A roster artist has no login of its own, so without this a
            // reviewer sees an artist with no account and no way to tell who
            // submitted the release or who to reach about it.
            label: {
              select: {
                id: true,
                name: true,
                owner: { select: { id: true, email: true } },
              },
            },
          },
        },
        reviewedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    if (!release) throw new NotFoundException('Release not found');

    const detail = await toReleaseDetail(release, this.storage);
    const history = await this.audit.forTarget('RELEASE', releaseId);

    // The artist, the reviewer and the trail behind them are context a reviewer
    // needs and an artist never does, so they are added here rather than pushed
    // into the shared mapper.
    return {
      ...detail,
      artist: release.artist,
      reviewedBy: release.reviewedBy
        ? {
            id: release.reviewedBy.id,
            name:
              [release.reviewedBy.firstName, release.reviewedBy.lastName]
                .filter(Boolean)
                .join(' ') || release.reviewedBy.email,
          }
        : null,
      history,
    };
  }

  /**
   * Takes the release off the queue and onto a desk.
   *
   * `IN_REVIEW` existed in the schema from the start and nothing ever set it.
   * This is what it is for: two people working the queue should not both spend
   * twenty minutes on the same album.
   */
  async claim(releaseId: string, adminUserId: string) {
    const release = await this.requireReviewable(releaseId);

    // Idempotent, and it returns before recording: opening an already-claimed
    // release a second time is not a new event, and logging it would bury the
    // claim that mattered under a page of refreshes.
    if (release.status === 'IN_REVIEW') return this.findOne(releaseId);

    await this.prisma.release.update({
      where: { id: releaseId },
      data: { status: 'IN_REVIEW', reviewedById: adminUserId },
    });

    await this.audit.record({
      adminUserId,
      action: 'RELEASE_CLAIMED',
      targetType: 'RELEASE',
      targetId: releaseId,
    });

    return this.findOne(releaseId);
  }

  async approve(releaseId: string, adminUserId: string) {
    await this.requireReviewable(releaseId);

    await this.prisma.release.update({
      where: { id: releaseId },
      data: {
        status: 'READY',
        reviewedAt: new Date(),
        reviewedById: adminUserId,
        // Cleared on the way through: a release that came back once and has
        // now passed should not still be showing the old reason.
        reviewNotes: null,
      },
    });

    await this.audit.record({
      adminUserId,
      action: 'RELEASE_APPROVED',
      targetType: 'RELEASE',
      targetId: releaseId,
    });

    await this.notifyOwner(releaseId, {
      type: 'RELEASE_APPROVED',
      title: 'Release approved',
      body: (title) =>
        `“${title}” has passed review. Nothing further is needed from you.`,
    });

    return this.findOne(releaseId);
  }

  /**
   * Sends it back with a reason.
   *
   * `REJECTED` is already wired on the artist's side — the release page shows
   * `reviewNotes` under "What needs fixing", and `isEditable` treats REJECTED
   * like DRAFT, so editing reopens immediately. Nothing else is needed to close
   * the loop.
   */
  async reject(releaseId: string, dto: RejectReleaseDto, adminUserId: string) {
    await this.requireReviewable(releaseId);

    await this.prisma.release.update({
      where: { id: releaseId },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
        reviewedById: adminUserId,
        reviewNotes: dto.notes.trim(),
      },
    });

    await this.audit.record({
      adminUserId,
      action: 'RELEASE_REJECTED',
      targetType: 'RELEASE',
      targetId: releaseId,
      // The note is copied into the log rather than referenced, so a later
      // resubmission clearing `reviewNotes` cannot erase what was said.
      detail: dto.notes,
    });

    await this.notifyOwner(releaseId, {
      type: 'RELEASE_REJECTED',
      title: 'Release sent back',
      // The reviewer's words verbatim. This is the only message the artist
      // gets, so paraphrasing it would lose the thing they have to act on.
      body: (title) =>
        `“${title}” needs a change before it can go further:

${dto.notes.trim()}`,
    });

    return this.findOne(releaseId);
  }

  /**
   * Tells the artist behind a release what was decided.
   *
   * The owner is looked up rather than passed in, because the caller has the
   * reviewer's id, not the artist's — and a release made by a label's roster
   * artist has no login at all, so the recipients are resolved rather than
   * read off the artist row.
   */
  private async notifyOwner(
    releaseId: string,
    message: {
      type: 'RELEASE_APPROVED' | 'RELEASE_REJECTED';
      title: string;
      body: (title: string) => string;
    },
  ) {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { title: true, artistId: true },
    });

    if (!release) return;

    // Was `artist.user?.id`, with a bare `return` when it was null — so a
    // label's release could be approved or rejected and nobody heard. The
    // resolver answers for a roster artist too.
    const recipients = await this.notifications.recipientsForArtist(
      release.artistId,
    );

    await this.notifications.notifyEach(recipients, {
      type: message.type,
      title: message.title,
      body: message.body(release.title),
      releaseId,
    });
  }

  private async requireReviewable(releaseId: string) {
    const release = await this.prisma.release.findUnique({
      where: { id: releaseId },
      select: { id: true, status: true },
    });

    if (!release) throw new NotFoundException('Release not found');

    if (!REVIEWABLE.includes(release.status)) {
      throw new BadRequestException(
        `This release is ${release.status} and is not awaiting review`,
      );
    }

    return release;
  }
}
