/**
 * Minimal readers for the three container formats we accept.
 *
 * Each returns only what the submission rules check. Anything the format does
 * not state (bit depth on a lossy file, for instance) comes back null rather
 * than guessed.
 */

export interface ProbeResult {
  /** "wav" | "flac" | "mp3", detected from the bytes, not the file name. */
  codec: string | null;
  durationSec: number | null;
  sampleRate: number | null;
  channels: number | null;
  bitDepth: number | null;
  /** False for lossy formats, where bit depth is not a meaningful check. */
  lossless: boolean;
}

export class UnreadableAudioError extends Error {
  constructor(message = 'The file is not readable audio') {
    super(message);
    this.name = 'UnreadableAudioError';
  }
}

/** Fetches a further byte range when the header runs past the first window. */
export type RangeReader = (start: number, end: number) => Promise<Buffer>;

export async function parseAudioHeader(
  head: Buffer,
  totalBytes: number,
  readRange: RangeReader,
): Promise<ProbeResult> {
  if (head.length < 12) {
    throw new UnreadableAudioError('The file is too small to be audio');
  }

  if (
    head.subarray(0, 4).toString('ascii') === 'RIFF' &&
    head.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return parseWav(head, totalBytes);
  }

  if (head.subarray(0, 4).toString('ascii') === 'fLaC') {
    return parseFlac(head);
  }

  return parseMp3(head, totalBytes, readRange);
}

// ── WAV ──────────────────────────────────────────────────────────────────────

function parseWav(head: Buffer, totalBytes: number): ProbeResult {
  let offset = 12;
  let format: {
    channels: number;
    sampleRate: number;
    byteRate: number;
    bitDepth: number;
  } | null = null;
  let dataSize: number | null = null;

  // RIFF is a chunk list: 4-byte id, 4-byte little-endian length, payload.
  while (offset + 8 <= head.length) {
    const id = head.subarray(offset, offset + 4).toString('ascii');
    const size = head.readUInt32LE(offset + 4);

    if (id === 'fmt ' && offset + 8 + 16 <= head.length) {
      format = {
        channels: head.readUInt16LE(offset + 10),
        sampleRate: head.readUInt32LE(offset + 12),
        byteRate: head.readUInt32LE(offset + 16),
        bitDepth: head.readUInt16LE(offset + 22),
      };
    }

    if (id === 'data') {
      // A streamed WAV can carry 0xFFFFFFFF here, meaning "unknown length".
      dataSize =
        size > 0 && size !== 0xffffffff
          ? Math.min(size, totalBytes - (offset + 8))
          : totalBytes - (offset + 8);
      break;
    }

    // Chunks are word-aligned, so an odd length is followed by a pad byte.
    offset += 8 + size + (size % 2);
  }

  if (!format || !format.sampleRate || !format.channels) {
    throw new UnreadableAudioError('The WAV header is missing or malformed');
  }

  // If the data chunk sits past the window we read, fall back to the file size.
  // Overshoots by the size of the remaining metadata, which is negligible.
  const audioBytes = dataSize ?? Math.max(0, totalBytes - 44);

  return {
    codec: 'wav',
    durationSec: format.byteRate > 0 ? audioBytes / format.byteRate : null,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitDepth: format.bitDepth || null,
    lossless: true,
  };
}

// ── FLAC ─────────────────────────────────────────────────────────────────────

function parseFlac(head: Buffer): ProbeResult {
  // The STREAMINFO block always comes first, right after the "fLaC" marker.
  // Layout: 1 flag/type byte, 3 length bytes, then 34 bytes of payload.
  const payload = head.subarray(8, 8 + 34);
  if (payload.length < 34) {
    throw new UnreadableAudioError('The FLAC header is truncated');
  }

  const blockType = head[4] & 0x7f;
  if (blockType !== 0) {
    throw new UnreadableAudioError('The FLAC stream info block is missing');
  }

  // Bytes 10–17 of STREAMINFO pack four fields across bit boundaries:
  // sample rate (20 bits), channels - 1 (3), bits per sample - 1 (5),
  // total samples (36).
  const packed = payload.subarray(10, 18);
  const sampleRate = (packed[0] << 12) | (packed[1] << 4) | (packed[2] >> 4);
  const channels = ((packed[2] >> 1) & 0x07) + 1;
  const bitDepth = (((packed[2] & 0x01) << 4) | (packed[3] >> 4)) + 1;

  // 36 bits is wider than a 32-bit shift can hold, so build it with arithmetic.
  const totalSamples =
    (packed[3] & 0x0f) * 2 ** 32 +
    packed[4] * 2 ** 24 +
    packed[5] * 2 ** 16 +
    packed[6] * 2 ** 8 +
    packed[7];

  if (!sampleRate) {
    throw new UnreadableAudioError('The FLAC header reports no sample rate');
  }

  return {
    codec: 'flac',
    // Zero means "unknown", which is legal in a stream.
    durationSec: totalSamples > 0 ? totalSamples / sampleRate : null,
    sampleRate,
    channels,
    bitDepth,
    lossless: true,
  };
}

// ── MP3 ──────────────────────────────────────────────────────────────────────

const MPEG_VERSIONS = [2.5, null, 2, 1] as const;
const SAMPLE_RATES: Record<string, number[]> = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};
const BITRATES_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const BITRATES_V2_L3 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];

async function parseMp3(
  head: Buffer,
  totalBytes: number,
  readRange: RangeReader,
): Promise<ProbeResult> {
  let buffer = head;
  let audioStart = 0;

  // An ID3v2 tag sits in front of the audio and can be megabytes with embedded
  // artwork, so skip past it — and re-read if it ran off the end of our window.
  if (
    buffer.subarray(0, 3).toString('ascii') === 'ID3' &&
    buffer.length >= 10
  ) {
    const tagSize = readSynchsafe(buffer, 6);
    audioStart = 10 + tagSize;

    if (audioStart >= buffer.length) {
      buffer = await readRange(audioStart, audioStart + 8191);
      audioStart = 0;
    }
  }

  const frameOffset = findFrameSync(buffer, audioStart);
  if (frameOffset === null) {
    throw new UnreadableAudioError(
      'No MP3 frame was found — the file may be corrupt or not audio',
    );
  }

  const header = buffer.readUInt32BE(frameOffset);
  const versionBits = (header >> 19) & 0x03;
  const layerBits = (header >> 17) & 0x03;
  const bitrateIndex = (header >> 12) & 0x0f;
  const sampleRateIndex = (header >> 10) & 0x03;
  const channelMode = (header >> 6) & 0x03;

  const version = MPEG_VERSIONS[versionBits];
  if (version === null || layerBits === 0 || sampleRateIndex === 3) {
    throw new UnreadableAudioError('The MP3 frame header is malformed');
  }

  const sampleRate = SAMPLE_RATES[String(version)]?.[sampleRateIndex];
  const bitrateTable = version === 1 ? BITRATES_V1_L3 : BITRATES_V2_L3;
  const bitrateKbps = bitrateTable[bitrateIndex] ?? 0;
  const channels = channelMode === 3 ? 1 : 2;
  const samplesPerFrame = version === 1 ? 1152 : 576;

  if (!sampleRate) {
    throw new UnreadableAudioError('The MP3 header reports no sample rate');
  }

  // A Xing or Info tag inside the first frame carries the real frame count,
  // which is the only accurate way to time a variable-bitrate file.
  const frameCount = readXingFrameCount(buffer, frameOffset);

  const durationSec = frameCount
    ? (frameCount * samplesPerFrame) / sampleRate
    : bitrateKbps > 0
      ? ((totalBytes - frameOffset) * 8) / (bitrateKbps * 1000)
      : null;

  return {
    codec: 'mp3',
    durationSec,
    sampleRate,
    channels,
    // Lossy: there is no bit depth to report.
    bitDepth: null,
    lossless: false,
  };
}

/** ID3 sizes use 7 bits per byte so the bytes never look like a frame sync. */
function readSynchsafe(buffer: Buffer, offset: number): number {
  return (
    ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f)
  );
}

/** First 11 set bits mark a frame. Scanning tolerates junk before the audio. */
function findFrameSync(buffer: Buffer, from: number): number | null {
  for (let i = from; i + 4 <= buffer.length; i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
      return i;
    }
  }
  return null;
}

function readXingFrameCount(
  buffer: Buffer,
  frameOffset: number,
): number | null {
  // The tag sits at a fixed offset after the frame header that depends on the
  // version and channel mode; checking the handful of valid spots is simpler
  // and just as reliable.
  for (const gap of [36, 21, 32, 17]) {
    const at = frameOffset + gap;
    if (at + 12 > buffer.length) continue;

    const marker = buffer.subarray(at, at + 4).toString('ascii');
    if (marker !== 'Xing' && marker !== 'Info') continue;

    const flags = buffer.readUInt32BE(at + 4);
    // Bit 0 says a frame count follows the flags.
    if (!(flags & 0x01)) return null;

    const frames = buffer.readUInt32BE(at + 8);
    return frames > 0 ? frames : null;
  }

  return null;
}
