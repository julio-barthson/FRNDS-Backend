import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  ORPHAN_ASSET_TTL_DAYS,
  PENDING_ASSET_TTL_HOURS,
} from './media.constants';
import { StorageService } from './storage.service';

/**
 * Storage is billed by what is stored, not by what is used. Two kinds of file
 * accumulate on their own and nobody notices until the invoice:
 *
 *   1. Reserved uploads the client never completed.
 *   2. Completed uploads never attached to a track or release, because the
 *      artist abandoned the form after picking a file.
 */
@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweep() {
    if (!this.storage.isConfigured) return;

    const pending = await this.sweepPending();
    const orphans = await this.sweepOrphans();

    if (pending || orphans) {
      this.logger.log(
        `Swept ${pending} unconfirmed and ${orphans} orphaned uploads`,
      );
    }
  }

  /** Reservations that never received a file. */
  private async sweepPending(): Promise<number> {
    const cutoff = new Date(
      Date.now() - PENDING_ASSET_TTL_HOURS * 60 * 60 * 1000,
    );

    const stale = await this.prisma.mediaAsset.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { id: true, key: true },
    });

    for (const asset of stale) {
      // The object usually will not exist; delete is idempotent either way.
      await this.storage.delete(asset.key);
      await this.prisma.mediaAsset.delete({ where: { id: asset.id } });
    }

    return stale.length;
  }

  /** Uploaded, but nothing in the catalogue points at it. */
  private async sweepOrphans(): Promise<number> {
    const cutoff = new Date(
      Date.now() - ORPHAN_ASSET_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const orphans = await this.prisma.mediaAsset.findMany({
      where: {
        status: 'UPLOADED',
        uploadedAt: { lt: cutoff },
        trackAudio: null,
        releaseArtwork: null,
        // Avatars are referenced by URL on the artist row, not by relation,
        // so they would look orphaned forever.
        kind: { not: 'AVATAR' },
      },
      select: { id: true, key: true },
    });

    for (const asset of orphans) {
      const deleted = await this.storage.delete(asset.key);
      if (!deleted) continue; // try again on the next run

      await this.prisma.mediaAsset.update({
        where: { id: asset.id },
        data: { status: 'DELETED', deletedAt: new Date() },
      });
    }

    return orphans.length;
  }
}
