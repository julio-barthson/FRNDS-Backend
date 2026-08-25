import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewService } from './review.service';

/** Past this, a submission is late rather than merely waiting. */
const OVERDUE_HOURS = 48;

/** How many of the longest-waiting submissions the dashboard shows. */
const OLDEST_SHOWN = 5;

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly review: ReviewService,
  ) {}

  /**
   * Everything the dashboard shows, in one request.
   *
   * Deliberately a single endpoint rather than one per tile: these are counts
   * over the same few tables, they are read together or not at all, and six
   * round trips to render one screen is six chances for it to render half.
   *
   * No charts and no time series. Nothing here is a trend — they are all
   * "right now" facts, which is what a person opening a review console needs
   * before they decide what to work on.
   */
  async overview() {
    const overdueBefore = new Date(
      Date.now() - OVERDUE_HOURS * 60 * 60 * 1000,
    );

    const [
      waiting,
      inReview,
      overdue,
      approved,
      rejected,
      drafts,
      releases,
      tracks,
      artists,
      labels,
      suspended,
      oldest,
    ] = await Promise.all([
      this.prisma.release.count({ where: { status: 'SUBMITTED' } }),
      this.prisma.release.count({ where: { status: 'IN_REVIEW' } }),
      // Counted off `submittedAt` rather than by filtering the queue in memory,
      // because the whole point of the number is that it stays right when the
      // queue is too long to hold.
      this.prisma.release.count({
        where: {
          status: { in: ['SUBMITTED', 'IN_REVIEW'] },
          submittedAt: { lt: overdueBefore },
        },
      }),
      this.prisma.release.count({ where: { status: 'READY' } }),
      this.prisma.release.count({ where: { status: 'REJECTED' } }),
      this.prisma.release.count({ where: { status: 'DRAFT' } }),
      this.prisma.release.count(),
      this.prisma.track.count(),
      // Counted off User rather than off Artist and Label. An account that
      // signed up and never finished onboarding has no artist row yet, so
      // counting profiles would report a smaller number than the accounts page
      // lists and leave the two screens disagreeing about the same people.
      this.prisma.user.count({
        where: { role: 'ARTIST', isDeleted: false },
      }),
      this.prisma.user.count({
        where: { role: 'LABEL', isDeleted: false },
      }),
      // Admins are excluded here as they are everywhere else in the console:
      // an admin's own account status is the Administrators page's business.
      this.prisma.user.count({
        where: {
          role: { in: ['ARTIST', 'LABEL'] },
          isDeleted: false,
          accountStatus: { not: 'ACTIVE' },
        },
      }),
      // The same rows the queue page renders, mapper and signed artwork
      // included — the dashboard's list has to link into review and look like
      // what it links to.
      this.review.queue({ limit: OLDEST_SHOWN }),
    ]);

    return {
      queue: { waiting, inReview, overdue, total: waiting + inReview },
      decisions: { approved, rejected },
      catalogue: { releases, drafts, tracks },
      accounts: { artists, labels, suspended, total: artists + labels },
      oldest: oldest.items,
      overdueHours: OVERDUE_HOURS,
    };
  }
}
