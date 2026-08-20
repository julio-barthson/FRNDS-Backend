/**
 * What a track has to satisfy before it counts as READY.
 *
 * These mirror what DSPs accept, so a file rejected here would have been
 * rejected later by a distributor — better to tell the artist now, while they
 * still have the session open, than after they think they're done.
 */
export const AUDIO_RULES = {
  /** Anything shorter is almost certainly a mistake or a clip. */
  minDurationSec: 5,
  /** 30 minutes covers long-form songs and mixes without inviting podcasts. */
  maxDurationSec: 30 * 60,
  /** CD quality is the industry floor; below it DSPs reject on ingest. */
  minSampleRate: 44100,
  minBitDepth: 16,
  /** Mono and stereo only — surround has nowhere to go on a streaming service. */
  allowedChannels: [1, 2],
  /** Detected from the file's own bytes, not from the declared mime type. */
  allowedCodecs: ['wav', 'flac', 'mp3'],
} as const;

/**
 * How much of the file to read. Every header we parse lives well inside this,
 * and an oversized ID3 tag triggers a second, targeted range request.
 */
export const HEADER_WINDOW_BYTES = 64 * 1024;

/**
 * Tracks left PROCESSING longer than this are assumed to have died with the
 * process (a deploy, a restart) and are retried by the sweep.
 */
export const STUCK_PROCESSING_MINUTES = 15;

/** After this many tries the track is failed rather than retried forever. */
export const MAX_PROCESSING_ATTEMPTS = 3;
