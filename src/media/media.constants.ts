import type { AssetKind } from '../generated/prisma/enums';

export interface KindRules {
  /** Hard ceiling enforced at presign and re-checked against the real object. */
  maxBytes: number;
  /** Mime types the client may declare. */
  mimeTypes: readonly string[];
  /** Extensions used when building the object key. */
  extensions: Record<string, string>;
}

const MB = 1024 * 1024;

export const ASSET_RULES: Record<AssetKind, KindRules> = {
  AUDIO: {
    // A 4-minute 24-bit/48kHz stereo WAV is roughly 70MB, so 100MB covers a
    // normal single without inviting someone to park a DJ set here.
    maxBytes: 100 * MB,
    mimeTypes: [
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
      'audio/flac',
      'audio/x-flac',
      'audio/mpeg',
    ],
    extensions: {
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/flac': 'flac',
      'audio/x-flac': 'flac',
      'audio/mpeg': 'mp3',
    },
  },
  ARTWORK: {
    // DSPs want 3000x3000. A JPEG that size lands well under 10MB; a PNG can
    // get close, which is why the ceiling is not tighter.
    maxBytes: 10 * MB,
    mimeTypes: ['image/jpeg', 'image/png'],
    extensions: { 'image/jpeg': 'jpg', 'image/png': 'png' },
  },
  AVATAR: {
    maxBytes: 5 * MB,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    extensions: {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    },
  },
};

/** How long a client has to complete the PUT. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/** Download links are short-lived so a shared URL stops working quickly. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * Cap on stored audio files per account for this phase. Nothing is being
 * distributed yet, so every upload is cost without revenue behind it.
 * Override with MAX_AUDIO_UPLOADS_PER_ARTIST.
 */
export const DEFAULT_MAX_AUDIO_UPLOADS_PER_ARTIST = 100;

/** Unconfirmed uploads older than this are swept. */
export const PENDING_ASSET_TTL_HOURS = 24;

/**
 * Uploaded files never attached to a track or release are swept after this
 * long. This is the real cost leak: an artist who uploads then abandons the
 * form leaves a 70MB object nothing points at.
 */
export const ORPHAN_ASSET_TTL_DAYS = 7;
