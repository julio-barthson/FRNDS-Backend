import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  releaseSummarySelect,
  toReleaseSummary,
} from '../catalogue/release.mapper';
import { DOWNLOAD_URL_TTL_SECONDS } from '../media/media.constants';
import { StorageService } from '../media/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ReleaseStatus } from '../generated/prisma/enums';

/**
 * The label dashboard, in one request.
 *
 * Counts come from a `groupBy` over the whole roster rather than from a page
 * of releases: a dashboard that quietly reports the totals of page one is
 * worse than one that reports nothing.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async forLabel(userId: string) {
    const label = await this.prisma.label.findUnique({
      where: { ownerId: userId },
      select: {
        id: true,
        name: true,
        artists: {
          select: {
            id: true,
            stageName: true,
            avatarUrl: true,
            avatarAsset: { select: { key: true, status: true } },
            spotifyArtistId: true,
            _count: { select: { releases: true } },
          },
          orderBy: { stageName: 'asc' },
        },
      },
    });

    if (!label) {
      throw new ForbiddenException('This account is not a label');
    }

    const artistIds = label.artists.map((artist) => artist.id);

    // An empty roster would make `in: []` match nothing, which is correct, but
    // skipping the queries entirely saves two round trips on the commonest
    // first-run state.
    if (artistIds.length === 0) {
      return {
        label: { id: label.id, name: label.name },
        roster: [],
        pipeline: {
          drafts: 0,
          awaitingReview: 0,
          needsChanges: 0,
          ready: 0,
          total: 0,
        },
        actionable: [],
      };
    }

    const [grouped, actionable] = await Promise.all([
      this.prisma.release.groupBy({
        by: ['status'],
        where: { artistId: { in: artistIds } },
        _count: { _all: true },
      }),
      // DRAFT and REJECTED are the only statuses the app can act on, and every
      // attention case the dashboard raises — rejected, missing audio, missing
      // artwork — comes from one of them. Capped: this feeds a short list on a
      // phone, not a work queue.
      this.prisma.release.findMany({
        where: {
          artistId: { in: artistIds },
          status: { in: ['DRAFT', 'REJECTED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: releaseSummarySelect,
      }),
    ]);

    const countOf = (...statuses: ReleaseStatus[]) =>
      grouped
        .filter((row) => statuses.includes(row.status))
        .reduce((sum, row) => sum + row._count._all, 0);

    return {
      label: { id: label.id, name: label.name },

      roster: await Promise.all(
        label.artists.map(async (artist) => ({
          id: artist.id,
          stageName: artist.stageName,
          avatarUrl:
            artist.avatarAsset?.status === 'UPLOADED' &&
            this.storage.isConfigured
              ? await this.storage.presignGet(
                  artist.avatarAsset.key,
                  DOWNLOAD_URL_TTL_SECONDS,
                )
              : artist.avatarUrl,
          releaseCount: artist._count.releases,
          // Drives a gentle nudge on the dashboard: an artist with no DSP profile
          // linked is fine now and a problem at delivery.
          hasSpotify: artist.spotifyArtistId !== null,
        })),
      ),

      pipeline: {
        drafts: countOf('DRAFT'),
        awaitingReview: countOf('SUBMITTED', 'IN_REVIEW'),
        needsChanges: countOf('REJECTED'),
        ready: countOf('READY'),
        total: grouped.reduce((sum, row) => sum + row._count._all, 0),
      },

      actionable: await Promise.all(
        actionable.map((release) => toReleaseSummary(release, this.storage)),
      ),
    };
  }
}
