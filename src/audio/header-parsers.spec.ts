import { parseAudioHeader, UnreadableAudioError } from './header-parsers';

/** No range reader should be needed for these fixtures. */
const noReads = jest.fn(() => {
  throw new Error('unexpected extra range request');
});

function wavHeader({
  channels = 2,
  sampleRate = 44100,
  bitDepth = 16,
  seconds = 10,
} = {}) {
  const byteRate = (sampleRate * channels * bitDepth) / 8;
  const dataBytes = byteRate * seconds;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE((channels * bitDepth) / 8, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  return { buffer, totalBytes: 44 + dataBytes };
}

function flacHeader({
  sampleRate = 48000,
  channels = 2,
  bitDepth = 24,
  totalSamples = 48000 * 180,
} = {}) {
  const buffer = Buffer.alloc(8 + 34);
  buffer.write('fLaC', 0, 'ascii');
  buffer[4] = 0x00; // STREAMINFO, not the last block
  buffer.writeUIntBE(34, 5, 3);

  const packed = Buffer.alloc(8);
  packed[0] = (sampleRate >> 12) & 0xff;
  packed[1] = (sampleRate >> 4) & 0xff;
  packed[2] =
    ((sampleRate & 0x0f) << 4) |
    (((channels - 1) & 0x07) << 1) |
    (((bitDepth - 1) >> 4) & 0x01);
  packed[3] =
    (((bitDepth - 1) & 0x0f) << 4) |
    (Math.floor(totalSamples / 2 ** 32) & 0x0f);
  packed.writeUInt32BE(totalSamples >>> 0, 4);
  packed.copy(buffer, 8 + 10);

  return buffer;
}

/** MPEG-1 Layer III, 44.1kHz, 128kbps, stereo. */
// 417 bytes is the real frame size at 128kbps / 44.1kHz.
function mp3Frame(extra = 413) {
  const buffer = Buffer.alloc(4 + extra);
  buffer[0] = 0xff;
  buffer[1] = 0xfb;
  buffer[2] = 0x90;
  buffer[3] = 0x00;
  return buffer;
}

describe('parseAudioHeader', () => {
  describe('wav', () => {
    it('reads rate, depth, channels and duration', async () => {
      const { buffer, totalBytes } = wavHeader();

      const result = await parseAudioHeader(buffer, totalBytes, noReads);

      expect(result).toMatchObject({
        codec: 'wav',
        sampleRate: 44100,
        channels: 2,
        bitDepth: 16,
        lossless: true,
      });
      expect(result.durationSec).toBeCloseTo(10, 3);
    });

    it('reads a 24-bit 96kHz mono file', async () => {
      const { buffer, totalBytes } = wavHeader({
        channels: 1,
        sampleRate: 96000,
        bitDepth: 24,
        seconds: 200,
      });

      const result = await parseAudioHeader(buffer, totalBytes, noReads);

      expect(result).toMatchObject({
        sampleRate: 96000,
        channels: 1,
        bitDepth: 24,
      });
      expect(result.durationSec).toBeCloseTo(200, 3);
    });

    it('skips over an unknown chunk before fmt', async () => {
      const { buffer, totalBytes } = wavHeader();
      const junk = Buffer.alloc(8 + 10);
      junk.write('LIST', 0, 'ascii');
      junk.writeUInt32LE(10, 4);

      const withJunk = Buffer.concat([
        buffer.subarray(0, 12),
        junk,
        buffer.subarray(12),
      ]);

      const result = await parseAudioHeader(
        withJunk,
        totalBytes + junk.length,
        noReads,
      );

      expect(result.sampleRate).toBe(44100);
      expect(result.durationSec).toBeCloseTo(10, 3);
    });

    it('rejects a RIFF file with no fmt chunk', async () => {
      const buffer = Buffer.alloc(44);
      buffer.write('RIFF', 0, 'ascii');
      buffer.write('WAVE', 8, 'ascii');

      await expect(
        parseAudioHeader(buffer, 44, noReads),
      ).rejects.toBeInstanceOf(UnreadableAudioError);
    });
  });

  describe('flac', () => {
    it('unpacks the bit-packed stream info block', async () => {
      const buffer = flacHeader();

      const result = await parseAudioHeader(buffer, 5_000_000, noReads);

      expect(result).toMatchObject({
        codec: 'flac',
        sampleRate: 48000,
        channels: 2,
        bitDepth: 24,
        lossless: true,
      });
      expect(result.durationSec).toBeCloseTo(180, 3);
    });

    it('handles a sample count above 2^32', async () => {
      const totalSamples = 2 ** 32 + 44100 * 60;
      const buffer = flacHeader({ sampleRate: 44100, totalSamples });

      const result = await parseAudioHeader(buffer, 5_000_000, noReads);

      expect(result.durationSec).toBeCloseTo(totalSamples / 44100, 1);
    });

    it('reports no duration when the sample count is unknown', async () => {
      const buffer = flacHeader({ totalSamples: 0 });

      const result = await parseAudioHeader(buffer, 5_000_000, noReads);

      expect(result.durationSec).toBeNull();
      expect(result.sampleRate).toBe(48000);
    });
  });

  describe('mp3', () => {
    it('estimates duration from the bitrate for a constant-rate file', async () => {
      // 128kbps for 10 seconds.
      const totalBytes = (128_000 / 8) * 10;

      const result = await parseAudioHeader(mp3Frame(), totalBytes, noReads);

      expect(result).toMatchObject({
        codec: 'mp3',
        sampleRate: 44100,
        channels: 2,
        bitDepth: null,
        lossless: false,
      });
      expect(result.durationSec).toBeCloseTo(10, 1);
    });

    it('prefers the Xing frame count on a variable-rate file', async () => {
      const frame = mp3Frame(60);
      frame.write('Xing', 36, 'ascii');
      frame.writeUInt32BE(0x01, 40); // frame-count flag
      frame.writeUInt32BE(3830, 44); // ≈100s at 1152 samples / 44100Hz

      // A wildly wrong file size: the Xing count must win.
      const result = await parseAudioHeader(frame, 10, noReads);

      expect(result.durationSec).toBeCloseTo(100, 0);
    });

    it('skips an ID3v2 tag that sits in front of the audio', async () => {
      const tagBody = 200;
      const tag = Buffer.alloc(10 + tagBody);
      tag.write('ID3', 0, 'ascii');
      // Synchsafe length: 7 bits per byte.
      tag[6] = 0;
      tag[7] = 0;
      tag[8] = (tagBody >> 7) & 0x7f;
      tag[9] = tagBody & 0x7f;

      const buffer = Buffer.concat([tag, mp3Frame()]);
      const result = await parseAudioHeader(buffer, 160_000, noReads);

      expect(result.codec).toBe('mp3');
      expect(result.sampleRate).toBe(44100);
    });

    it('re-reads when an oversized ID3 tag runs past the window', async () => {
      const tag = Buffer.alloc(10);
      tag.write('ID3', 0, 'ascii');
      const tagBody = 1_000_000; // artwork-sized
      tag[6] = (tagBody >> 21) & 0x7f;
      tag[7] = (tagBody >> 14) & 0x7f;
      tag[8] = (tagBody >> 7) & 0x7f;
      tag[9] = tagBody & 0x7f;

      const readRange = jest.fn().mockResolvedValue(mp3Frame());

      const result = await parseAudioHeader(
        Buffer.concat([tag, Buffer.alloc(1000)]),
        2_000_000,
        readRange,
      );

      expect(readRange).toHaveBeenCalledWith(10 + tagBody, 10 + tagBody + 8191);
      expect(result.codec).toBe('mp3');
    });

    it('rejects a file that is not audio at all', async () => {
      const buffer = Buffer.alloc(2000, 0x42);

      await expect(
        parseAudioHeader(buffer, 2000, noReads),
      ).rejects.toBeInstanceOf(UnreadableAudioError);
    });
  });

  it('rejects a file too small to hold a header', async () => {
    await expect(
      parseAudioHeader(Buffer.alloc(4), 4, noReads),
    ).rejects.toBeInstanceOf(UnreadableAudioError);
  });
});
