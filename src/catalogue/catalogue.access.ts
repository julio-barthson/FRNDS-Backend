import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AssetKind, ReleaseStatus } from '../generated/prisma/enums';

/** Statuses an artist is still allowed to change. */
const EDITABLE_STATUSES: ReleaseStatus[] = ['DRAFT', 'REJECTED'];

/**
 * Ownership and attachment rules shared by the release and track services.
 *
 * Every catalogue query is scoped through the caller's own artist row, so a
 * release id belonging to someone else reads as "not found" rather than
 * leaking that it exists.
 */
@Injectable()
export class CatalogueAccess {
  constructor(private readonly prisma: PrismaService) {}

  /** The artist profile behind a login. Created at signup, so it should exist. */
  async artistFor(
    userId: string,
  ): Promise<{ id: string; labelId: string | null; stageName: string }> {
    const artist = await this.prisma.artist.findUnique({
      where: { userId },
      // `stageName` comes along because a new release is billed to it by
      // default — the account uploading is the artist on the cover unless it
      // says otherwise.
      select: { id: true, labelId: true, stageName: true },
    });

    if (!artist) {
      throw new ForbiddenException(
        'This account has no artist profile and cannot manage releases',
      );
    }

    return artist;
  }

  assertEditable(status: ReleaseStatus) {
    if (!EDITABLE_STATUSES.includes(status)) {
      throw new BadRequestException(
        `This release has been submitted and can no longer be edited (status: ${status})`,
      );
    }
  }

  /**
   * Confirms an uploaded file may be attached here: it exists, belongs to the
   * caller, finished uploading, is the right kind, and is not already in use
   * somewhere else.
   */
  async assertAssetUsable(
    userId: string,
    assetId: string,
    kind: AssetKind,
    exclude: { trackId?: string; releaseId?: string } = {},
  ) {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
      select: { id: true, ownerId: true, kind: true, status: true },
    });

    if (!asset || asset.status === 'DELETED') {
      throw new NotFoundException('Uploaded file not found');
    }

    if (asset.ownerId !== userId) {
      throw new ForbiddenException('This file belongs to another account');
    }

    if (asset.kind !== kind) {
      throw new BadRequestException(
        `Expected ${kind.toLowerCase()} here, got ${asset.kind.toLowerCase()}`,
      );
    }

    if (asset.status !== 'UPLOADED') {
      throw new BadRequestException(
        'This file has not been confirmed yet. Call POST /media/{id}/confirm first.',
      );
    }

    // The schema enforces this with a unique constraint; checking first turns a
    // raw constraint violation into a message the app can show.
    if (kind === 'AUDIO') {
      const inUse = await this.prisma.track.findFirst({
        where: {
          audioAssetId: assetId,
          ...(exclude.trackId && { NOT: { id: exclude.trackId } }),
        },
        select: { id: true },
      });
      if (inUse) {
        throw new BadRequestException(
          'That audio file is already attached to another track',
        );
      }
    }

    if (kind === 'ARTWORK') {
      const inUse = await this.prisma.release.findFirst({
        where: {
          artworkAssetId: assetId,
          ...(exclude.releaseId && { NOT: { id: exclude.releaseId } }),
        },
        select: { id: true },
      });
      if (inUse) {
        throw new BadRequestException(
          'That artwork is already attached to another release',
        );
      }
    }
  }
}
