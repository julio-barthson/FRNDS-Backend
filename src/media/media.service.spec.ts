import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_MAX_AUDIO_UPLOADS_PER_ARTIST } from './media.constants';
import { MediaService } from './media.service';
import { StorageService } from './storage.service';

const USER = 'user-1';
const OTHER_USER = 'user-2';

describe('MediaService', () => {
  let service: MediaService;
  let prisma: {
    mediaAsset: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    track: { findFirst: jest.Mock };
    release: { findFirst: jest.Mock };
  };
  let storage: {
    bucket: string;
    presignPut: jest.Mock;
    presignGet: jest.Mock;
    head: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      mediaAsset: {
        create: jest.fn().mockResolvedValue({ id: 'asset-1' }),
        update: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      track: { findFirst: jest.fn().mockResolvedValue(null) },
      release: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    storage = {
      bucket: 'test-bucket',
      presignPut: jest.fn().mockResolvedValue('https://storage/put'),
      presignGet: jest.fn().mockResolvedValue('https://storage/get'),
      head: jest.fn(),
      delete: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();

    service = module.get(MediaService);
  });

  describe('createUploadUrl', () => {
    it('issues a ticket and stores a server-generated key', async () => {
      const ticket = await service.createUploadUrl(USER, {
        kind: 'AUDIO',
        mimeType: 'audio/wav',
        sizeBytes: 40 * 1024 * 1024,
        fileName: 'master.wav',
      });

      expect(ticket.uploadUrl).toBe('https://storage/put');
      expect(ticket.headers['Content-Type']).toBe('audio/wav');

      const calls = prisma.mediaAsset.create.mock.calls as [
        { data: { key: string; status: string; ownerId: string } },
      ][];
      const { data } = calls[0][0];
      expect(data.status).toBe('PENDING');
      expect(data.ownerId).toBe(USER);
      // Namespaced per user, never the client's filename.
      expect(data.key).toMatch(new RegExp(`^audio/${USER}/[0-9a-f-]+\\.wav$`));
      expect(data.key).not.toContain('master');
    });

    it('rejects a mime type the kind does not accept', async () => {
      await expect(
        service.createUploadUrl(USER, {
          kind: 'AUDIO',
          mimeType: 'application/zip',
          sizeBytes: 1000,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
    });

    it('rejects a file over the size ceiling before presigning', async () => {
      await expect(
        service.createUploadUrl(USER, {
          kind: 'ARTWORK',
          mimeType: 'image/png',
          sizeBytes: 50 * 1024 * 1024,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.presignPut).not.toHaveBeenCalled();
    });

    it('enforces the per-account audio quota', async () => {
      // Read from the constant rather than repeated as a literal. The limit is
      // a tuning knob — it has already moved from 10 to 100 — and a test that
      // hardcodes the old value fails for a change that is not a regression.
      prisma.mediaAsset.count.mockResolvedValue(
        DEFAULT_MAX_AUDIO_UPLOADS_PER_ARTIST,
      );

      await expect(
        service.createUploadUrl(USER, {
          kind: 'AUDIO',
          mimeType: 'audio/mpeg',
          sizeBytes: 5_000_000,
        }),
      ).rejects.toThrow(/Upload limit reached/);
    });
  });

  describe('confirmUpload', () => {
    const pendingAsset = {
      id: 'asset-1',
      ownerId: USER,
      kind: 'AUDIO' as const,
      key: 'audio/user-1/file.wav',
      status: 'PENDING' as const,
      mimeType: 'audio/wav',
      sizeBytes: 1000,
      createdAt: new Date(),
      uploadedAt: null,
    };

    it('refuses to confirm when nothing was actually uploaded', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(pendingAsset);
      storage.head.mockResolvedValue(null);

      await expect(service.confirmUpload(USER, 'asset-1')).rejects.toThrow(
        /No file found/,
      );
      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
    });

    it('records the real size from storage, not the declared one', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(pendingAsset);
      storage.head.mockResolvedValue({
        sizeBytes: 4242,
        mimeType: 'audio/wav',
        etag: 'abc123',
      });
      prisma.mediaAsset.update.mockResolvedValue({
        ...pendingAsset,
        status: 'UPLOADED',
        sizeBytes: 4242,
        uploadedAt: new Date(),
      });

      const result = await service.confirmUpload(USER, 'asset-1');

      expect(result.sizeBytes).toBe(4242);
      const calls = prisma.mediaAsset.update.mock.calls as [
        { data: { status: string; checksum: string } },
      ][];
      const { data } = calls[0][0];
      expect(data.status).toBe('UPLOADED');
      expect(data.checksum).toBe('abc123');
    });

    it('deletes and fails an object that is larger than allowed', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(pendingAsset);
      storage.head.mockResolvedValue({ sizeBytes: 500 * 1024 * 1024 });

      await expect(service.confirmUpload(USER, 'asset-1')).rejects.toThrow(
        /too large/,
      );
      expect(storage.delete).toHaveBeenCalledWith(pendingAsset.key);
    });

    it("will not touch another account's file", async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({
        ...pendingAsset,
        ownerId: OTHER_USER,
      });

      await expect(
        service.confirmUpload(USER, 'asset-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('treats a deleted asset as missing', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue({
        ...pendingAsset,
        status: 'DELETED',
      });

      await expect(
        service.confirmUpload(USER, 'asset-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deleteAsset', () => {
    const uploaded = {
      id: 'asset-1',
      ownerId: USER,
      kind: 'AUDIO' as const,
      key: 'audio/user-1/file.wav',
      status: 'UPLOADED' as const,
      mimeType: 'audio/wav',
      sizeBytes: 1000,
      createdAt: new Date(),
      uploadedAt: new Date(),
    };

    it('removes a file still attached to a draft', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(uploaded);
      prisma.track.findFirst.mockResolvedValue({
        release: { status: 'DRAFT' },
      });

      await service.deleteAsset(USER, 'asset-1');

      expect(storage.delete).toHaveBeenCalledWith(uploaded.key);
    });

    it('refuses once the release has been submitted', async () => {
      prisma.mediaAsset.findUnique.mockResolvedValue(uploaded);
      prisma.track.findFirst.mockResolvedValue({
        release: { status: 'SUBMITTED' },
      });

      await expect(service.deleteAsset(USER, 'asset-1')).rejects.toThrow(
        /already been submitted/,
      );
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });
});
