import { displayArtist, displayTitle } from './billing';
import type { Prisma } from '../generated/prisma/client';
import { DOWNLOAD_URL_TTL_SECONDS } from '../media/media.constants';
import type { StorageService } from '../media/storage.service';

/** Everything the detail view needs, in one query. */
const contributorSelect = {
  select: {
    id: true,
    name: true,
    role: true,
    roleNote: true,
    position: true,
  },
  // Billing order, which is a decision. `createdAt` was standing in for it and
  // is merely the order someone happened to type the names in.
  orderBy: { position: 'asc' },
} as const;

/** Everything the detail view needs, in one query. */
export const releaseInclude = {
  artworkAsset: { select: { id: true, key: true, status: true } },
  contributors: contributorSelect,
  tracks: {
    orderBy: [{ discNumber: 'asc' }, { trackNumber: 'asc' }],
    include: {
      audioAsset: { select: { id: true, key: true, status: true } },
      contributors: contributorSelect,
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
  const releaseDisplayArtist = displayArtist(release.contributors);

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
      // A track with no billing of its own inherits the release's, whole. That
      // covers nearly every track on nearly every album, and it has to be all
      // of it rather than just the artist line: on a single, where the feature
      // is naturally set on the release, composing the track's title from its
      // own empty list left the page header reading "Song (feat. X)" over a
      // track row still reading "Song".
      displayArtist:
        displayArtist(track.contributors) || releaseDisplayArtist,
      // Composed here rather than stored, and never written back into `title`.
      // See `billing.ts` — a store builds this string itself, and a title with
      // "feat." typed into it is a rejection.
      displayTitle: displayTitle(
        track.title,
        track.versionTitle,
        track.contributors.length ? track.contributors : release.contributors,
      ),
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
    contributors: release.contributors,
    displayArtist: releaseDisplayArtist,
    displayTitle: displayTitle(release.title, null, release.contributors),
    submittedAt: release.submittedAt,
    reviewedAt: release.reviewedAt,
    reviewNotes: release.reviewNotes,
    rightsConfirmedAt: release.rightsConfirmedAt,
    createdAt: release.createdAt,
    updatedAt: release.updatedAt,
    tracks,
  };
}
