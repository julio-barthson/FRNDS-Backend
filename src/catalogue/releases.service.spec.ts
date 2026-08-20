import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { AudioValidationService } from '../audio/audio-validation.service';
import { CatalogueAccess } from './catalogue.access';
import { ReleasesService } from './releases.service';

const USER = 'user-1';
const ARTIST = { id: 'artist-1', labelId: null };

const completeRelease = {
  id: 'release-1',
  title: 'Test Single',
  type: 'SINGLE',
  status: 'DRAFT',
  artworkAssetId: 'artwork-1',
  primaryGenre: 'Afrobeats',
  artworkAsset: { id: 'artwork-1', key: 'artwork/k', status: 'UPLOADED' },
  tracks: [
    {
      id: 'track-1',
      title: 'Test Track',
      trackNumber: 1,
      discNumber: 1,
      audioAssetId: 'audio-1',
      status: 'READY',
      audioAsset: { id: 'audio-1', key: 'audio/k', status: 'UPLOADED' },
      contributors: [],
    },
  ],
};

describe('ReleasesService', () => {
  let service: ReleasesService;
  let prisma: {
    release: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
  };
  let access: {
    artistFor: jest.Mock;
    assertEditable: jest.Mock;
    assertAssetUsable: jest.Mock;
  };
  let audio: { enqueue: jest.Mock };

  beforeEach(async () => {
    prisma = {
      release: {
        create: jest.fn().mockResolvedValue(completeRelease),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn().mockResolvedValue(completeRelease),
        delete: jest.fn(),
      },
    };
    access = {
      artistFor: jest.fn().mockResolvedValue(ARTIST),
      assertEditable: jest.fn(),
      assertAssetUsable: jest.fn(),
    };
    audio = { enqueue: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReleasesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CatalogueAccess, useValue: access },
        { provide: StorageService, useValue: { isConfigured: false } },
        { provide: AudioValidationService, useValue: audio },
      ],
    }).compile();

    service = module.get(ReleasesService);
  });

  describe('create', () => {
    it('numbers tracks and queues validation for attached audio', async () => {
      await service.create(USER, {
        title: 'Test Single',
        primaryGenre: 'Afrobeats',
        tracks: [{ title: 'Test Track', audioAssetId: 'audio-1' }],
      });

      const calls = prisma.release.create.mock.calls as [
        {
          data: {
            type: string;
            status: string;
            tracks: {
              create: { trackNumber: number; status: string }[];
            };
          };
        },
      ][];
      const { data } = calls[0][0];

      expect(data.type).toBe('SINGLE');
      expect(data.status).toBe('DRAFT');
      expect(data.tracks.create[0].trackNumber).toBe(1);
      // Not READY: the file has not been checked yet.
      expect(data.tracks.create[0].status).toBe('PROCESSING');
      expect(audio.enqueue).toHaveBeenCalledWith('track-1');
    });

    it('leaves a track without audio pending', async () => {
      // The returned row drives the enqueue loop, so it has to match the input.
      prisma.release.create.mockResolvedValue({
        ...completeRelease,
        tracks: [{ ...completeRelease.tracks[0], audioAssetId: null }],
      });

      await service.create(USER, {
        title: 'Test Single',
        tracks: [{ title: 'Test Track' }],
      });

      const calls = prisma.release.create.mock.calls as [
        { data: { tracks: { create: { status: string }[] } } },
      ][];
      expect(calls[0][0].data.tracks.create[0].status).toBe('PENDING_UPLOAD');
      expect(audio.enqueue).not.toHaveBeenCalled();
    });

    it('infers EP from the track count', async () => {
      await service.create(USER, {
        title: 'Test EP',
        tracks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
      });

      const calls = prisma.release.create.mock.calls as [
        { data: { type: string } },
      ][];
      expect(calls[0][0].data.type).toBe('EP');
    });

    it('rejects a single with more than one track', async () => {
      await expect(
        service.create(USER, {
          title: 'Test',
          type: 'SINGLE',
          tracks: [{ title: 'One' }, { title: 'Two' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects the same audio file on two tracks', async () => {
      await expect(
        service.create(USER, {
          title: 'Test EP',
          type: 'EP',
          tracks: [
            { title: 'One', audioAssetId: 'audio-1' },
            { title: 'Two', audioAssetId: 'audio-1' },
          ],
        }),
      ).rejects.toThrow(/cannot be used for two tracks/);
    });
  });

  describe('submit', () => {
    it('reports every missing item at once', async () => {
      prisma.release.findFirst.mockResolvedValue({
        ...completeRelease,
        artworkAssetId: null,
        primaryGenre: null,
        tracks: [
          {
            ...completeRelease.tracks[0],
            audioAssetId: null,
            status: 'PENDING_UPLOAD',
          },
        ],
      });

      const error = await service
        .submit(USER, 'release-1', { confirmRights: true })
        .catch((caught: BadRequestException) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        message: string[];
      };
      expect(response.message).toEqual([
        'Cover artwork is required',
        'A primary genre is required',
        '"Test Track" has no audio file',
      ]);
    });

    it('blocks a track that failed audio checks', async () => {
      prisma.release.findFirst.mockResolvedValue({
        ...completeRelease,
        tracks: [{ ...completeRelease.tracks[0], status: 'FAILED' }],
      });

      const error = (await service
        .submit(USER, 'release-1', { confirmRights: true })
        .catch((caught: BadRequestException) => caught)) as BadRequestException;

      const response = error.getResponse() as { message: string[] };
      expect(response.message).toContain(
        '"Test Track" failed audio checks and must be replaced',
      );
    });

    it('records the rights confirmation when everything is present', async () => {
      prisma.release.findFirst.mockResolvedValue(completeRelease);

      await service.submit(USER, 'release-1', { confirmRights: true });

      const calls = prisma.release.update.mock.calls as [
        {
          data: { status: string; rightsConfirmedAt: Date; submittedAt: Date };
        },
      ][];
      const { data } = calls[0][0];

      expect(data.status).toBe('SUBMITTED');
      expect(data.rightsConfirmedAt).toBeInstanceOf(Date);
      expect(data.submittedAt).toBeInstanceOf(Date);
    });
  });

  describe('ownership', () => {
    it("treats another artist's release as missing", async () => {
      prisma.release.findFirst.mockResolvedValue(null);

      await expect(service.findOne(USER, 'release-9')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      // The lookup is scoped by artist, not filtered after the fact.
      const calls = prisma.release.findFirst.mock.calls as [
        { where: { artistId: string } },
      ][];
      expect(calls[0][0].where.artistId).toBe(ARTIST.id);
    });
  });
});
