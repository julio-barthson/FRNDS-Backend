import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DOWNLOAD_URL_TTL_SECONDS } from '../media/media.constants';
import { StorageService } from '../media/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { uniqueSlug } from '../utils/slug';
import {
  CreateRosterArtistDto,
  UpdateRosterArtistDto,
} from './dto/roster-artist.dto';

/**
 * A Spotify artist id is 22 base62 characters; Apple's is numeric. Labels
 * paste the profile URL far more often than the bare id, so both are accepted
 * and reduced to the id — the same affordance every distributor's roster form
 * offers.
 */
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const APPLE_ID = /^\d+$/;

function normaliseSpotifyId(input?: string): string | undefined {
  if (input === undefined) return undefined;

  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  const fromUrl =
    /open\.spotify\.com\/(?:intl-[a-z]+\/)?artist\/([A-Za-z0-9]{22})/.exec(
      trimmed,
    );
  const id = fromUrl?.[1] ?? trimmed;

  if (!SPOTIFY_ID.test(id)) {
    throw new BadRequestException(
      'That does not look like a Spotify artist link or id',
    );
  }
  return id;
}

function normaliseAppleId(input?: string): string | undefined {
  if (input === undefined) return undefined;

  const trimmed = input.trim();
  if (trimmed === '') return undefined;

  // Apple's URLs end in the id, sometimes followed by a query string.
  const fromUrl = /music\.apple\.com\/[^\s]*\/artist\/[^/]+\/(\d+)/.exec(
    trimmed,
  );
  const id = fromUrl?.[1] ?? trimmed;

  if (!APPLE_ID.test(id)) {
    throw new BadRequestException(
      'That does not look like an Apple Music artist link or id',
    );
  }
  return id;
}

const rosterArtistSelect = {
  id: true,
  stageName: true,
  slug: true,
  legalName: true,
  bio: true,
  country: true,
  avatarUrl: true,
  avatarAsset: { select: { key: true, status: true } },
  spotifyArtistId: true,
  appleMusicArtistId: true,
  userId: true,
  createdAt: true,
} as const;

@Injectable()
export class RosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Collapses the two ways an artist can have a picture into the one field the
   * app reads.
   *
   * An uploaded avatar lives in a private bucket, so it is signed per response
   * and expires; `avatarUrl` on its own is for pictures that came from
   * elsewhere, like a Google profile image, and is handed back untouched.
   */
  private async withAvatar<
    T extends {
      avatarUrl: string | null;
      avatarAsset: { key: string; status: string } | null;
    },
  >(artist: T): Promise<Omit<T, 'avatarAsset'> & { avatarUrl: string | null }> {
    const { avatarAsset, ...rest } = artist;

    const signed =
      avatarAsset?.status === 'UPLOADED' && this.storage.isConfigured
        ? await this.storage.presignGet(
            avatarAsset.key,
            DOWNLOAD_URL_TTL_SECONDS,
          )
        : null;

    return { ...rest, avatarUrl: signed ?? artist.avatarUrl };
  }

  /**
   * An avatar has to be the caller's own finished AVATAR upload.
   *
   * Deliberately not `CatalogueAccess.assertAssetUsable`: that also enforces
   * the one-asset-one-release rule for artwork and audio, which does not apply
   * here, and it lives in a module this one does not depend on.
   */
  private async assertAvatarUsable(userId: string, assetId: string) {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: assetId },
      select: { id: true, ownerId: true, kind: true, status: true },
    });

    if (!asset || asset.status === 'DELETED') {
      throw new NotFoundException('Uploaded file not found');
    }
    if (asset.ownerId !== userId) {
      throw new ForbiddenException('This file belongs to another account');
    }
    if (asset.kind !== 'AVATAR') {
      throw new BadRequestException(
        `Expected an avatar here, got ${asset.kind.toLowerCase()}`,
      );
    }
    if (asset.status !== 'UPLOADED') {
      throw new BadRequestException(
        'This file has not been confirmed yet. Call POST /media/{id}/confirm first.',
      );
    }
  }

  /**
   * The label behind a login.
   *
   * Only a label owner has a roster. A solo artist calling these routes is a
   * 403 rather than an empty list, because the roster is not a thing their
   * account has — saying so is clearer than pretending it is empty.
   */
  private async labelFor(userId: string): Promise<{ id: string }> {
    const label = await this.prisma.label.findUnique({
      where: { ownerId: userId },
      select: { id: true },
    });

    if (!label) {
      throw new ForbiddenException(
        'This account is not a label and has no roster',
      );
    }

    return label;
  }

  async list(userId: string) {
    const label = await this.labelFor(userId);

    const artists = await this.prisma.artist.findMany({
      where: { labelId: label.id },
      select: {
        ...rosterArtistSelect,
        _count: { select: { releases: true } },
      },
      orderBy: { stageName: 'asc' },
    });

    return Promise.all(
      artists.map(async ({ _count, userId: artistUserId, ...artist }) => ({
        ...(await this.withAvatar(artist)),
        releaseCount: _count.releases,
        // Whether this identity also has a login of its own. False for every
        // artist a label creates; the seat layer that changes it is a later
        // phase, and the app needs to know not to offer edits that a seated
        // artist owns.
        hasOwnLogin: artistUserId !== null,
      })),
    );
  }

  async findOne(userId: string, artistId: string) {
    const label = await this.labelFor(userId);

    const artist = await this.prisma.artist.findFirst({
      where: { id: artistId, labelId: label.id },
      select: rosterArtistSelect,
    });

    // Scoped to the label, so another label's artist reads as missing rather
    // than forbidden — the same rule release ids follow.
    if (!artist) throw new NotFoundException('Artist not found');
    return this.withAvatar(artist);
  }

  async create(userId: string, dto: CreateRosterArtistDto) {
    const label = await this.labelFor(userId);
    const stageName = dto.stageName.trim();

    // Scoped to this label: two labels may both have a "Wave", and blocking
    // that would leak one label's roster into another's namespace. The slug
    // stays globally unique, which is what the public identifier needs.
    const duplicate = await this.prisma.artist.findFirst({
      where: {
        labelId: label.id,
        stageName: { equals: stageName, mode: 'insensitive' },
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new BadRequestException(`${stageName} is already on your roster`);
    }

    if (dto.avatarAssetId) {
      await this.assertAvatarUsable(userId, dto.avatarAssetId);
    }

    const created = await this.prisma.artist.create({
      data: {
        avatarAssetId: dto.avatarAssetId,
        labelId: label.id,
        // No user: a roster artist is an identity the label owns. This is the
        // case `Artist.userId` was made nullable for.
        userId: null,
        stageName,
        slug: await this.uniqueArtistSlug(stageName),
        legalName: dto.legalName?.trim(),
        bio: dto.bio?.trim(),
        country: dto.country?.toUpperCase(),
        avatarUrl: dto.avatarUrl,
        spotifyArtistId: normaliseSpotifyId(dto.spotifyArtistId),
        appleMusicArtistId: normaliseAppleId(dto.appleMusicArtistId),
      },
      select: rosterArtistSelect,
    });

    return this.withAvatar(created);
  }

  async update(userId: string, artistId: string, dto: UpdateRosterArtistDto) {
    const existing = await this.findOne(userId, artistId);

    // Renaming moves the public slug, which has to stay unique. Only recomputed
    // on an actual change, so re-saving a form does not walk the slug to -2.
    const stageName = dto.stageName?.trim();
    const renamed = stageName !== undefined && stageName !== existing.stageName;

    if (dto.avatarAssetId) {
      await this.assertAvatarUsable(userId, dto.avatarAssetId);
    }

    const updated = await this.prisma.artist.update({
      where: { id: artistId },
      data: {
        ...(dto.avatarAssetId !== undefined && {
          avatarAssetId: dto.avatarAssetId,
        }),
        ...(stageName !== undefined && { stageName }),
        ...(renamed && { slug: await this.uniqueArtistSlug(stageName) }),
        ...(dto.legalName !== undefined && { legalName: dto.legalName.trim() }),
        ...(dto.bio !== undefined && { bio: dto.bio.trim() }),
        ...(dto.country !== undefined && {
          country: dto.country.toUpperCase(),
        }),
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
        ...(dto.spotifyArtistId !== undefined && {
          spotifyArtistId: normaliseSpotifyId(dto.spotifyArtistId) ?? null,
        }),
        ...(dto.appleMusicArtistId !== undefined && {
          appleMusicArtistId: normaliseAppleId(dto.appleMusicArtistId) ?? null,
        }),
      },
      select: rosterArtistSelect,
    });

    return this.withAvatar(updated);
  }

  /**
   * Removing an artist who has releases is refused rather than cascaded.
   *
   * `Release.artistId` is required, so deleting the row would orphan or destroy
   * catalogue — and a label that signed an artist and released records cannot
   * un-sign the history. An artist who has released nothing is a data-entry
   * mistake and deletes cleanly.
   */
  async remove(userId: string, artistId: string) {
    await this.findOne(userId, artistId);

    const releases = await this.prisma.release.count({ where: { artistId } });
    if (releases > 0) {
      throw new BadRequestException(
        `This artist has ${releases} release${releases === 1 ? '' : 's'} and cannot be removed from the roster`,
      );
    }

    await this.prisma.artist.delete({ where: { id: artistId } });
    return { id: artistId, removed: true };
  }

  private uniqueArtistSlug(stageName: string): Promise<string> {
    return uniqueSlug(stageName, 'artist', async (slug) =>
      Boolean(
        await this.prisma.artist.findUnique({
          where: { slug },
          select: { id: true },
        }),
      ),
    );
  }
}
