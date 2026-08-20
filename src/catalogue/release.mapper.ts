import type { Prisma } from '../generated/prisma/client';
import { DOWNLOAD_URL_TTL_SECONDS } from '../media/media.constants';
import type { StorageService } from '../media/storage.service';

/** Everything the detail view needs, in one query. */
export const releaseInclude = {
  artworkAsset: { select: { id: true, key: true, status: true } },
  tracks: {
    orderBy: [{ discNumber: 'asc' }, { trackNumber: 'asc' }],
    include: {
      audioAsset: { select: { id: true, key: true, status: true } },
      contributors: {
        select: { id: true, name: true, role: true, roleNote: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  },
} satisfies Prisma.ReleaseInclude;

export type ReleaseWithTracks = Prisma.ReleaseGetPayload<{
  include: typeof releaseInclude;
}>;

/**
 * Signing is local HMAC work, not a network call, so handing out fresh URLs
 * with every response is cheap. They expire in five minutes; the client should
 * fetch the list again rather than cache them.
 */
async function signIfPossible(
  storage: StorageService,
  asset: { key: string; status: string } | null,
): Promise<string | null> {
  if (!asset || asset.status !== 'UPLOADED') return null;
  if (!storage.isConfigured) return null;
  return storage.presignGet(asset.key, DOWNLOAD_URL_TTL_SECONDS);
}

export async function toReleaseDetail(
  release: ReleaseWithTracks,
  storage: StorageService,
) {
  const artworkUrl = await signIfPossible(storage, release.artworkAsset);

  const tracks = await Promise.all(
    release.tracks.map(async (track) => ({
      id: track.id,
      title: track.title,
      versionTitle: track.versionTitle,
      trackNumber: track.trackNumber,
      discNumber: track.discNumber,
      isrc: track.isrc,
      explicit: track.explicit,
      lyrics: track.lyrics,
      status: track.status,
      processingError: track.processingError,
      durationSec: track.durationSec,
      sampleRate: track.sampleRate,
      audioAssetId: track.audioAssetId,
      audioUrl: await signIfPossible(storage, track.audioAsset),
      contributors: track.contributors,
    })),
  );

  return {
    id: release.id,
    title: release.title,
    type: release.type,
    status: release.status,
    upc: release.upc,
    releaseDate: release.releaseDate,
    language: release.language,
    primaryGenre: release.primaryGenre,
    secondaryGenre: release.secondaryGenre,
    cLine: release.cLine,
    pLine: release.pLine,
    artworkAssetId: release.artworkAssetId,
    artworkUrl,
    submittedAt: release.submittedAt,
    reviewedAt: release.reviewedAt,
    reviewNotes: release.reviewNotes,
    rightsConfirmedAt: release.rightsConfirmedAt,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
    tracks,
  };
}
