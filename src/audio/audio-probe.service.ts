import { Injectable, Logger } from '@nestjs/common';
import { HEADER_WINDOW_BYTES } from './audio.constants';
import { parseAudioHeader, UnreadableAudioError } from './header-parsers';
import type { ProbeResult } from './header-parsers';

export { UnreadableAudioError };
export type { ProbeResult };

/**
 * Reads an uploaded file's technical details without ffmpeg.
 *
 * Sample rate, bit depth, channel count and duration all live in the first few
 * kilobytes of a WAV, FLAC or MP3, so this range-reads the header instead of
 * pulling a 70MB master across the network. That keeps the check to a fraction
 * of a second, avoids shipping an 80MB binary to a small Render instance, and
 * needs no temp disk.
 *
 * What it cannot do is inspect the audio itself — clipping, silence and
 * loudness need a full decode. That is a separate job for when there is a
 * worker to run it on, and it is why lufs and peakDb stay null for now.
 */
@Injectable()
export class AudioProbeService {
  private readonly logger = new Logger(AudioProbeService.name);

  async probe(url: string, totalBytes: number): Promise<ProbeResult> {
    const head = await this.readRange(url, 0, HEADER_WINDOW_BYTES - 1);

    return parseAudioHeader(head, totalBytes, (start, end) =>
      this.readRange(url, start, end),
    );
  }

  /** HTTP range request. S3 and R2 both answer these with a 206. */
  private async readRange(
    url: string,
    start: number,
    end: number,
  ): Promise<Buffer> {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
    });

    if (!response.ok) {
      throw new Error(`Storage returned HTTP ${response.status}`);
    }

    if (response.status !== 206) {
      // A 200 means the host ignored the range and sent everything. Still
      // usable, just wasteful, so it is worth knowing about.
      this.logger.warn(
        'Storage ignored the range request and sent the whole file',
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
