import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AudioProbeService, UnreadableAudioError } from './audio-probe.service';
import {
  AudioValidationService,
  checkAgainstRules,
} from './audio-validation.service';
import type { ProbeResult } from './header-parsers';

const goodProbe: ProbeResult = {
  codec: 'wav',
  durationSec: 210.4,
  sampleRate: 44100,
  channels: 2,
  bitDepth: 16,
  lossless: true,
};

describe('checkAgainstRules', () => {
  it('passes a normal CD-quality master', () => {
    expect(checkAgainstRules(goodProbe)).toEqual([]);
  });

  it('rejects a sample rate below CD quality', () => {
    const problems = checkAgainstRules({ ...goodProbe, sampleRate: 22050 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/22050Hz/);
  });

  it('rejects a clip that is too short', () => {
    const problems = checkAgainstRules({ ...goodProbe, durationSec: 2 });
    expect(problems[0]).toMatch(/minimum is 5/);
  });

  it('rejects surround audio', () => {
    const problems = checkAgainstRules({ ...goodProbe, channels: 6 });
    expect(problems[0]).toMatch(/mono or stereo/);
  });

  it('does not hold a missing bit depth against a lossy file', () => {
    expect(
      checkAgainstRules({
        ...goodProbe,
        codec: 'mp3',
        bitDepth: null,
        lossless: false,
      }),
    ).toEqual([]);
  });

  it('reports several faults together', () => {
    const problems = checkAgainstRules({
      codec: 'wav',
      durationSec: 1,
      sampleRate: 8000,
      channels: 6,
      bitDepth: 8,
      lossless: true,
    });
    expect(problems).toHaveLength(4);
  });
});

describe('AudioValidationService', () => {
  let service: AudioValidationService;
  let prisma: { track: { findUnique: jest.Mock; update: jest.Mock } };
  let storage: { isConfigured: boolean; presignGet: jest.Mock };
  let probe: { probe: jest.Mock };
  let notifications: {
    recipientsForArtist: jest.Mock;
    notifyEach: jest.Mock;
  };

  const trackWithAudio = {
    id: 'track-1',
    processingAttempts: 0,
    audioAsset: { key: 'audio/k', status: 'UPLOADED', sizeBytes: 5_000_000 },
  };

  /** The last data payload written to the track row. */
  const lastUpdate = () => {
    const calls = prisma.track.update.mock.calls as [
      { data: Record<string, unknown> },
    ][];
    return calls[calls.length - 1][0].data;
  };

  beforeEach(async () => {
    prisma = {
      track: {
        findUnique: jest.fn(),
        // `fail` reads the updated row back to work out who to tell, so the
        // mock has to answer with the release it belongs to.
        update: jest.fn().mockResolvedValue({
          title: 'Test Track',
          release: {
            id: 'release-1',
            title: 'Test Single',
            artistId: 'artist-1',
          },
        }),
      },
    };
    notifications = {
      recipientsForArtist: jest.fn().mockResolvedValue(['user-1']),
      notifyEach: jest.fn(),
    };
    storage = {
      isConfigured: true,
      presignGet: jest.fn().mockResolvedValue('https://storage/get'),
    };
    probe = { probe: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AudioValidationService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: AudioProbeService, useValue: probe },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get(AudioValidationService);
  });

  it('stores the measurements and marks a good file ready', async () => {
    prisma.track.findUnique.mockResolvedValue(trackWithAudio);
    probe.probe.mockResolvedValue(goodProbe);

    await service.validate('track-1');

    expect(lastUpdate()).toMatchObject({
      status: 'READY',
      durationSec: 210,
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      processingError: null,
    });
  });

  it('fails a file that breaks a rule and says why', async () => {
    prisma.track.findUnique.mockResolvedValue(trackWithAudio);
    probe.probe.mockResolvedValue({ ...goodProbe, sampleRate: 22050 });

    await service.validate('track-1');

    const data = lastUpdate();
    expect(data.status).toBe('FAILED');
    expect(data.processingError).toMatch(/22050Hz/);
    // The measurements are kept so the app can explain the rejection.
    expect(data.sampleRate).toBe(22050);
  });

  it('fails an unreadable file without retrying it', async () => {
    prisma.track.findUnique.mockResolvedValue(trackWithAudio);
    probe.probe.mockRejectedValue(new UnreadableAudioError('Not audio'));

    await service.validate('track-1');

    expect(lastUpdate()).toMatchObject({ status: 'FAILED' });
  });

  it('leaves the track processing when storage itself fails', async () => {
    prisma.track.findUnique.mockResolvedValue(trackWithAudio);
    probe.probe.mockRejectedValue(new Error('connection reset'));

    await service.validate('track-1');

    // Only the "PROCESSING" write happened — the sweep will try again.
    expect(prisma.track.update).toHaveBeenCalledTimes(1);
    expect(lastUpdate()).toMatchObject({ status: 'PROCESSING' });
  });

  it('gives up after the attempt cap instead of looping forever', async () => {
    prisma.track.findUnique.mockResolvedValue({
      ...trackWithAudio,
      processingAttempts: 3,
    });

    await service.validate('track-1');

    expect(probe.probe).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'FAILED' });
  });

  it('passes tracks through when storage is not configured', async () => {
    storage.isConfigured = false;
    prisma.track.findUnique.mockResolvedValue(trackWithAudio);

    await service.validate('track-1');

    expect(probe.probe).not.toHaveBeenCalled();
    expect(lastUpdate()).toMatchObject({ status: 'READY' });
  });

  it('fails a track whose file was never confirmed', async () => {
    prisma.track.findUnique.mockResolvedValue({
      ...trackWithAudio,
      audioAsset: { key: 'audio/k', status: 'PENDING', sizeBytes: null },
    });

    await service.validate('track-1');

    expect(lastUpdate()).toMatchObject({ status: 'FAILED' });
  });
});
