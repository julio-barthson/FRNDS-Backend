import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AUDIO_RULES,
  MAX_PROCESSING_ATTEMPTS,
  STUCK_PROCESSING_MINUTES,
} from './audio.constants';
import {
  AudioProbeService,
  UnreadableAudioError,
  type ProbeResult,
} from './audio-probe.service';

/** Only needs to outlive one range request. */
const PROBE_URL_TTL_SECONDS = 5 * 60;

@Injectable()
export class AudioValidationService {
  private readonly logger = new Logger(AudioValidationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly probe: AudioProbeService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Called when audio is attached to a track. Marks the track PROCESSING and
   * runs the probe in the background — the artist's request returns straight
   * away instead of waiting on a file read.
   *
   * If the process dies mid-probe the track stays PROCESSING and the sweep
   * below picks it up.
   */
  enqueue(trackId: string): void {
    void this.validate(trackId).catch((error) => {
      this.logger.error(
        `Validation crashed for track ${trackId}: ${message(error)}`,
      );
    });
  }

  /**
   * Probes the attached file and moves the track to READY or FAILED.
   * Safe to call again — the sweep relies on that.
   */
  async validate(trackId: string): Promise<void> {
    const track = await this.prisma.track.findUnique({
      where: { id: trackId },
      select: {
        id: true,
        processingAttempts: true,
        audioAsset: { select: { key: true, status: true, sizeBytes: true } },
      },
    });

    if (!track) return;

    if (!track.audioAsset || track.audioAsset.status !== 'UPLOADED') {
      await this.fail(trackId, 'No uploaded audio file is attached');
      return;
    }

    // Without storage credentials there is nothing to probe. Rather than leave
    // every track stuck in PROCESSING on a half-configured environment, pass
    // them through and say so in the log.
    if (!this.storage.isConfigured) {
      this.logger.warn(
        `Storage not configured — skipping audio checks for track ${trackId}`,
      );
      await this.prisma.track.update({
        where: { id: trackId },
        data: { status: 'READY', processingError: null },
      });
      return;
    }

    if (track.processingAttempts >= MAX_PROCESSING_ATTEMPTS) {
      await this.fail(
        trackId,
        'We could not read this file after several attempts. Please upload it again.',
      );
      return;
    }

    await this.prisma.track.update({
      where: { id: trackId },
      data: {
        status: 'PROCESSING',
        processingAttempts: { increment: 1 },
      },
    });

    let result: ProbeResult;
    try {
      const url = await this.storage.presignGet(
        track.audioAsset.key,
        PROBE_URL_TTL_SECONDS,
      );
      result = await this.probe.probe(url, track.audioAsset.sizeBytes ?? 0);
    } catch (error) {
      if (error instanceof UnreadableAudioError) {
        // The file itself is the problem, so retrying will not help.
        await this.fail(
          trackId,
          `${error.message}. Upload a WAV, FLAC or MP3.`,
        );
        return;
      }

      // Anything else is our problem, not the file's — leave it PROCESSING so
      // the sweep retries, until the attempt cap turns it into a failure.
      this.logger.error(`Probe failed for track ${trackId}: ${message(error)}`);
      return;
    }

    const problems = checkAgainstRules(result);

    if (problems.length) {
      await this.fail(trackId, problems.join(' '), result);
      return;
    }

    await this.prisma.track.update({
      where: { id: trackId },
      data: {
        status: 'READY',
        processingError: null,
        durationSec: result.durationSec ? Math.round(result.durationSec) : null,
        sampleRate: result.sampleRate,
        bitDepth: result.bitDepth,
        channels: result.channels,
      },
    });

    this.logger.log(
      `Track ${trackId} ready (${result.codec ?? 'unknown'}, ${result.sampleRate ?? '?'}Hz, ${Math.round(result.durationSec ?? 0)}s)`,
    );
  }

  /**
   * Rescues tracks whose probe never finished — usually a deploy or restart
   * landing mid-check. Without this they sit in PROCESSING and the artist can
   * never submit.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async retryStuck(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_PROCESSING_MINUTES * 60 * 1000);

    const stuck = await this.prisma.track.findMany({
      where: { status: 'PROCESSING', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: 20,
    });

    if (!stuck.length) return;

    this.logger.log(`Retrying ${stuck.length} stuck track(s)`);
    for (const track of stuck) {
      await this.validate(track.id).catch((error) =>
        this.logger.error(`Retry failed for ${track.id}: ${message(error)}`),
      );
    }
  }

  /**
   * Marks the track failed and tells whoever looks after the artist.
   *
   * This is terminal — a FAILED track is not retried until a new file is
   * attached, which resets it to PROCESSING — so there is no risk of notifying
   * once per attempt.
   */
  private async fail(trackId: string, reason: string, result?: ProbeResult) {
    const track = await this.prisma.track.update({
      where: { id: trackId },
      data: {
        status: 'FAILED',
        processingError: reason,
        // Keep whatever was measured: it explains the rejection in the app.
        ...(result && {
          durationSec: result.durationSec
            ? Math.round(result.durationSec)
            : null,
          sampleRate: result.sampleRate,
          bitDepth: result.bitDepth,
          channels: result.channels,
        }),
      },
      select: {
        title: true,
        release: { select: { id: true, title: true, artistId: true } },
      },
    });

    const recipients = await this.notifications.recipientsForArtist(
      track.release.artistId,
    );

    await this.notifications.notifyEach(recipients, {
      type: 'TRACK_AUDIO_FAILED',
      title: 'A track needs a new file',
      // The reason is the probe's own words, which name the actual problem —
      // a sample rate, a channel count. Generic copy here would send someone
      // back to the app to find out what this sentence already knows.
      body: `“${track.title}” on “${track.release.title}” did not pass its audio checks. ${reason}`,
      releaseId: track.release.id,
    });
  }
}

/** Reasons the artist can act on, phrased for the app, not for a log. */
export function checkAgainstRules(result: ProbeResult): string[] {
  const problems: string[] = [];

  if (
    result.codec &&
    !AUDIO_RULES.allowedCodecs.includes(result.codec as never)
  ) {
    problems.push(
      `${result.codec} is not a supported format — upload a WAV, FLAC or MP3.`,
    );
  }

  if (!result.durationSec) {
    problems.push('The length of this file could not be read.');
  } else if (result.durationSec < AUDIO_RULES.minDurationSec) {
    problems.push(
      `The track is only ${Math.round(result.durationSec)} seconds long — the minimum is ${AUDIO_RULES.minDurationSec}.`,
    );
  } else if (result.durationSec > AUDIO_RULES.maxDurationSec) {
    problems.push(
      `The track is longer than ${AUDIO_RULES.maxDurationSec / 60} minutes.`,
    );
  }

  if (!result.sampleRate) {
    problems.push('The sample rate could not be read.');
  } else if (result.sampleRate < AUDIO_RULES.minSampleRate) {
    problems.push(
      `The sample rate is ${result.sampleRate}Hz — streaming platforms need at least ${AUDIO_RULES.minSampleRate}Hz.`,
    );
  }

  // Lossy files report no bit depth, which is expected rather than a fault.
  if (
    result.lossless &&
    result.bitDepth &&
    result.bitDepth < AUDIO_RULES.minBitDepth
  ) {
    problems.push(
      `The bit depth is ${result.bitDepth}-bit — the minimum is ${AUDIO_RULES.minBitDepth}-bit.`,
    );
  }

  if (
    result.channels &&
    !AUDIO_RULES.allowedChannels.includes(result.channels as never)
  ) {
    problems.push(
      `The file has ${result.channels} channels — upload mono or stereo.`,
    );
  }

  return problems;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
