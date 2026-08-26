import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { AudioValidationService } from '../audio/audio-validation.service';
import { assertNoTypedFeature, normaliseContributors } from './billing';
import { CatalogueAccess } from './catalogue.access';
import { TrackInputDto } from './dto/create-release.dto';
import { ReorderTracksDto } from './dto/reorder-tracks.dto';
import { UpdateTrackDto } from './dto/update-track.dto';
import { releaseInclude, toReleaseDetail } from './release.mapper';

@Injectable()
export class TracksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CatalogueAccess,
    private readonly storage: StorageService,
    private readonly audio: AudioValidationService,
  ) {}

  async addTrack(userId: string, releaseId: string, dto: TrackInputDto) {
    const release = await this.findEditableRelease(userId, releaseId);

    if (release.type === 'SINGLE') {
      throw new BadRequestException(
        'A single holds one track. Change the release type to EP or album first.',
      );
    }

    assertNoTypedFeature(dto.title, 'track title');

    if (dto.audioAssetId) {
      await this.access.assertAssetUsable(userId, dto.audioAssetId, 'AUDIO');
    }

    const nextNumber =
      Math.max(0, ...release.tracks.map((track) => track.trackNumber)) + 1;

    const track = await this.prisma.track.create({
      data: {
        releaseId,
        title: dto.title.trim(),
        versionTitle: dto.versionTitle,
        trackNumber: nextNumber,
        explicit: dto.explicit ?? false,
        lyrics: dto.lyrics,
        audioAssetId: dto.audioAssetId,
        status: dto.audioAssetId ? 'PROCESSING' : 'PENDING_UPLOAD',
        ...(dto.contributors?.length && {
          contributors: { create: normaliseContributors(dto.contributors) },
        }),
      },
      select: { id: true },
    });

    if (dto.audioAssetId) this.audio.enqueue(track.id);

    return this.reload(releaseId);
  }

  /**
   * The usual path for attaching audio: the app creates the draft, uploads the
   * file, then patches the track with the confirmed asset id.
   */
  async updateTrack(
    userId: string,
    releaseId: string,
    trackId: string,
    dto: UpdateTrackDto,
  ) {
    const release = await this.findEditableRelease(userId, releaseId);
    const track = release.tracks.find((candidate) => candidate.id === trackId);

    if (!track) throw new NotFoundException('Track not found');

    if (dto.title !== undefined) assertNoTypedFeature(dto.title, 'track title');

    if (dto.audioAssetId) {
      await this.access.assertAssetUsable(userId, dto.audioAssetId, 'AUDIO', {
        trackId,
      });
    }

    await this.prisma.track.update({
      where: { id: trackId },
      data: {
        ...(dto.title !== undefined && { title: dto.title.trim() }),
        ...(dto.versionTitle !== undefined && {
          versionTitle: dto.versionTitle,
        }),
        ...(dto.explicit !== undefined && { explicit: dto.explicit }),
        ...(dto.lyrics !== undefined && { lyrics: dto.lyrics }),
        ...(dto.audioAssetId !== undefined && {
          audioAssetId: dto.audioAssetId,
          // A new file clears whatever the previous one measured, and resets
          // the attempt counter so the fresh upload gets its full retries.
          status: dto.audioAssetId
            ? ('PROCESSING' as const)
            : ('PENDING_UPLOAD' as const),
          processingError: null,
          processingAttempts: 0,
          durationSec: null,
          sampleRate: null,
          bitDepth: null,
          channels: null,
          lufs: null,
          peakDb: null,
        }),
        // Contributors are replaced wholesale — the app sends the full list it
        // is showing, which is simpler than diffing rows from a phone.
        ...(dto.contributors !== undefined && {
          contributors: {
            deleteMany: {},
            ...(dto.contributors.length && {
              create: normaliseContributors(dto.contributors),
            }),
          },
        }),
      },
    });

    if (dto.audioAssetId) this.audio.enqueue(trackId);

    return this.reload(releaseId);
  }

  async removeTrack(userId: string, releaseId: string, trackId: string) {
    const release = await this.findEditableRelease(userId, releaseId);
    const track = release.tracks.find((candidate) => candidate.id === trackId);

    if (!track) throw new NotFoundException('Track not found');

    if (release.tracks.length === 1) {
      throw new BadRequestException(
        'A release must keep at least one track. Delete the release instead.',
      );
    }

    const remaining = release.tracks
      .filter((candidate) => candidate.id !== trackId)
      .sort((a, b) => a.trackNumber - b.trackNumber);

    // Renumber ascending inside the same transaction. Numbers only ever move
    // down, so this never collides with the (release, disc, number) unique key.
    await this.prisma.$transaction([
      this.prisma.track.delete({ where: { id: trackId } }),
      ...remaining.map((candidate, index) =>
        this.prisma.track.update({
          where: { id: candidate.id },
          data: { trackNumber: index + 1 },
        }),
      ),
    ]);

    return this.reload(releaseId);
  }

  /**
   * Sets the running order from a list of ids.
   *
   * Written in two passes over one transaction. `@@unique([releaseId,
   * discNumber, trackNumber])` is checked per statement, so assigning the final
   * numbers directly collides the moment two tracks swap — the first update
   * would claim a number the second still holds. The first pass parks every
   * track on the negative of its new position, which no real row ever uses, and
   * the second brings them up to the positive number now that it is free.
   */
  async reorderTracks(
    userId: string,
    releaseId: string,
    dto: ReorderTracksDto,
  ) {
    const release = await this.findEditableRelease(userId, releaseId);

    const existing = new Set(release.tracks.map((track) => track.id));
    const requested = new Set(dto.trackIds);

    // A permutation of exactly what is on the release, or nothing. Anything
    // less would leave tracks holding stale numbers and silently reorder a
    // release differently from what the artist saw.
    if (
      requested.size !== dto.trackIds.length ||
      requested.size !== existing.size ||
      dto.trackIds.some((id) => !existing.has(id))
    ) {
      throw new BadRequestException(
        'Send every track on this release exactly once, in the order they should play.',
      );
    }

    await this.prisma.$transaction([
      ...dto.trackIds.map((id, index) =>
        this.prisma.track.update({
          where: { id },
          data: { trackNumber: -(index + 1) },
        }),
      ),
      ...dto.trackIds.map((id, index) =>
        this.prisma.track.update({
          where: { id },
          data: { trackNumber: index + 1 },
        }),
      ),
    ]);

    return this.reload(releaseId);
  }

  private async findEditableRelease(userId: string, releaseId: string) {
    const scope = await this.access.scopeFor(userId);

    const release = await this.prisma.release.findFirst({
      where: { id: releaseId, artistId: { in: scope.artistIds } },
      include: releaseInclude,
    });

    if (!release) throw new NotFoundException('Release not found');
    this.access.assertEditable(release.status);

    return release;
  }

  /** Track changes return the whole release so the app can re-render once. */
  private async reload(releaseId: string) {
    const release = await this.prisma.release.findUniqueOrThrow({
      where: { id: releaseId },
      include: releaseInclude,
    });

    return toReleaseDetail(release, this.storage);
  }
}
