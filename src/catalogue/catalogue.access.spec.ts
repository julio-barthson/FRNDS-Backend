import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogueAccess } from './catalogue.access';

const USER = 'user-1';

/**
 * Seats are the first thing in this codebase that can read a release without
 * being allowed to change it, so the read/write split is worth pinning down.
 */
describe('CatalogueAccess', () => {
  let prisma: {
    artist: { findUnique: jest.Mock };
    label: { findUnique: jest.Mock };
    artistSeat: { findMany: jest.Mock };
  };
  let access: CatalogueAccess;

  beforeEach(async () => {
    prisma = {
      artist: { findUnique: jest.fn().mockResolvedValue(null) },
      label: { findUnique: jest.fn().mockResolvedValue(null) },
      artistSeat: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogueAccess,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    access = module.get(CatalogueAccess);
  });

  describe('scopeFor', () => {
    it('gives a solo artist write access to their own row', async () => {
      prisma.artist.findUnique.mockResolvedValue({
        id: 'artist-1',
        labelId: null,
        stageName: 'Wave',
      });

      const scope = await access.scopeFor(USER);

      expect(scope.artistIds).toEqual(['artist-1']);
      expect(scope.writableArtistIds).toEqual(['artist-1']);
      expect(scope.defaultArtist).toEqual({
        id: 'artist-1',
        stageName: 'Wave',
      });
    });

    it('gives a label its whole roster, and no default when there is a choice', async () => {
      prisma.label.findUnique.mockResolvedValue({
        id: 'label-1',
        artists: [
          { id: 'artist-1', stageName: 'Wave' },
          { id: 'artist-2', stageName: 'Kilode' },
        ],
      });

      const scope = await access.scopeFor(USER);

      expect(scope.artistIds).toEqual(['artist-1', 'artist-2']);
      expect(scope.writableArtistIds).toEqual(['artist-1', 'artist-2']);
      // Two artists, so `create` must ask rather than bill the wrong one.
      expect(scope.defaultArtist).toBeNull();
    });

    it('lets a VIEWER seat read an artist but not write to them', async () => {
      prisma.artistSeat.findMany.mockResolvedValue([
        { artistId: 'artist-9', role: 'VIEWER' },
      ]);

      const scope = await access.scopeFor(USER);

      expect(scope.artistIds).toEqual(['artist-9']);
      expect(scope.writableArtistIds).toEqual([]);
    });

    it('lets a MANAGER seat write', async () => {
      prisma.artistSeat.findMany.mockResolvedValue([
        { artistId: 'artist-9', role: 'MANAGER' },
      ]);

      const scope = await access.scopeFor(USER);

      expect(scope.writableArtistIds).toEqual(['artist-9']);
    });

    it('unions an own profile with seats rather than picking one', async () => {
      prisma.artist.findUnique.mockResolvedValue({
        id: 'artist-1',
        labelId: null,
        stageName: 'Wave',
      });
      prisma.artistSeat.findMany.mockResolvedValue([
        { artistId: 'artist-9', role: 'VIEWER' },
      ]);

      const scope = await access.scopeFor(USER);

      // An independent artist can also hold a seat elsewhere; returning only
      // the first match would hide half of what they can reach.
      expect(scope.artistIds.sort()).toEqual(['artist-1', 'artist-9']);
      expect(scope.writableArtistIds).toEqual(['artist-1']);
    });

    it('refuses an account with no artist, label or seat', async () => {
      await expect(access.scopeFor(USER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('assertWritable', () => {
    const scope = {
      artistIds: ['artist-1', 'artist-9'],
      writableArtistIds: ['artist-1'],
      labelId: null,
      defaultArtist: null,
    };

    it('passes for an artist the caller can change', () => {
      expect(() => access.assertWritable(scope, 'artist-1')).not.toThrow();
    });

    it('refuses one the caller can only read', () => {
      // Forbidden, not NotFound: they can legitimately see this artist, so
      // pretending it does not exist would confuse rather than protect.
      expect(() => access.assertWritable(scope, 'artist-9')).toThrow(
        ForbiddenException,
      );
    });
  });

  describe('resolveReleaseArtist', () => {
    it('refuses to bill a release to a view-only artist', async () => {
      const scope = {
        artistIds: ['artist-9'],
        writableArtistIds: [],
        labelId: null,
        defaultArtist: null,
      };

      await expect(
        access.resolveReleaseArtist(scope, 'artist-9'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reads an artist outside the scope entirely as missing', async () => {
      const scope = {
        artistIds: ['artist-1'],
        writableArtistIds: ['artist-1'],
        labelId: null,
        defaultArtist: null,
      };

      await expect(
        access.resolveReleaseArtist(scope, 'someone-else'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
