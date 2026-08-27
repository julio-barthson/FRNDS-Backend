import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AssetKind, ReleaseStatus } from '../generated/prisma/enums';

/** Statuses an artist is still allowed to change. */
const EDITABLE_STATUSES: ReleaseStatus[] = ['DRAFT', 'REJECTED'];

/**
 * Ownership and attachment rules shared by the release and track services.
 *
 * Every catalogue query is scoped through the caller's own artist row, so a
 * release id belonging to someone else reads as "not found" rather than
 * leaking that it exists.
 */
/**
 * What an account may act on in the catalogue. Built by
 * {@link CatalogueAccess.scopeFor}.
 */
export interface CatalogueScope {
  /** Everything the caller may READ: their own artist, a whole roster, seats. */
  artistIds: string[];
  /**
   * The subset they may CHANGE.
   *
   * Identical to `artistIds` for a solo artist and for a label — they own what
   * they can see. It narrows only for seats, where a VIEWER reads an artist's
   * catalogue without being able to touch it. Read paths scope by `artistIds`;
   * every mutation goes through {@link CatalogueAccess.assertWritable}.
   */
  writableArtistIds: string[];
  /** The label behind the caller, whether they are the label or signed to one. */
  labelId: string | null;
  /** Who a new release bills to when the caller does not say. Null forces a choice. */
  defaultArtist: { id: string; stageName: string } | null;
}

@Injectable()
export class CatalogueAccess {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The artist rows this account may act on.
   *
   * A solo artist resolves to their own row. A label resolves to its whole
   * roster — the industry model, where the label is the operating account and
   * a roster artist is a metadata identity it owns rather than a login. That is
   * why `Artist.userId` is nullable: most roster artists never have one.
   *
   * Every catalogue query scopes through `artistIds`, so a release belonging to
   * another account still reads as "not found" rather than leaking that it
   * exists.
   */
  async scopeFor(userId: string): Promise<CatalogueScope> {
    // All three are unioned rather than chosen between: an independent artist
    // can also hold a seat on someone else's roster, and picking the first
    // match would have made half their catalogue disappear.
    const [artist, label, seats] = await Promise.all([
      this.prisma.artist.findUnique({
        where: { userId },
        // `stageName` comes along because a new release is billed to it by
        // default — the account uploading is the artist on the cover unless it
        // says otherwise.
        select: { id: true, labelId: true, stageName: true },
      }),
      this.prisma.label.findUnique({
        where: { ownerId: userId },
        select: { id: true, artists: { select: { id: true, stageName: true } } },
      }),
      this.prisma.artistSeat.findMany({
        where: { userId, status: 'ACTIVE' },
        select: { artistId: true, role: true },
      }),
    ]);

    const readable = new Set<string>();
    const writable = new Set<string>();

    if (artist) {
      readable.add(artist.id);
      writable.add(artist.id);
    }

    for (const rosterArtist of label?.artists ?? []) {
      readable.add(rosterArtist.id);
      writable.add(rosterArtist.id);
    }

    for (const seat of seats) {
      readable.add(seat.artistId);
      // The whole point of the role: a VIEWER sees the catalogue and cannot
      // change it.
      if (seat.role === 'MANAGER') writable.add(seat.artistId);
    }

    if (readable.size === 0) {
      throw new ForbiddenException(
        'This account has no artist or label profile and cannot manage releases',
      );
    }

    return {
      artistIds: [...readable],
      writableArtistIds: [...writable],
      labelId: artist?.labelId ?? label?.id ?? null,
      // Their own artist row bills a release without asking. A label with one
      // artist has no ambiguity either. Anything else has to be named, rather
      // than guessed at and billed to the wrong artist.
      defaultArtist: artist
        ? { id: artist.id, stageName: artist.stageName }
        : label?.artists.length === 1
          ? { id: label.artists[0].id, stageName: label.artists[0].stageName }
          : null,
    };
  }

  /**
   * Refuses a change to an artist the caller may only read.
   *
   * A 403 rather than a 404 on purpose: unlike a foreign release id, the caller
   * can legitimately see this one, so pretending it does not exist would be
   * confusing rather than protective.
   */
  assertWritable(scope: CatalogueScope, artistId: string) {
    if (!scope.writableArtistIds.includes(artistId)) {
      throw new ForbiddenException(
        'You have view-only access to this artist and cannot change their releases',
      );
    }
  }

  /**
   * Resolves which artist a new release belongs to.
   *
   * A label must name one, unless its roster holds exactly one artist. Naming
   * an artist outside the caller's scope reads as a 404 for the same reason
   * release ids do — it must not confirm that another label's artist exists.
   */
  async resolveReleaseArtist(
    scope: CatalogueScope,
    artistId?: string,
  ): Promise<{ id: string; labelId: string | null; stageName: string }> {
    const target = artistId ?? scope.defaultArtist?.id;

    if (!target) {
      throw new BadRequestException(
        'Name the artist this release belongs to — a label with more than one roster artist has no default',
      );
    }

    // Checked against the writable set: a VIEWER seat can see an artist but
    // must not be able to start a release under their name.
    if (!scope.writableArtistIds.includes(target)) {
      if (scope.artistIds.includes(target)) {
        throw new ForbiddenException(
          'You have view-only access to this artist and cannot create releases for them',
        );
      }
      throw new NotFoundException('Artist not found');
    }

    const artist = await this.prisma.artist.findUnique({
      where: { id: target },
      select: { id: true, labelId: true, stageName: true },
    });

    if (!artist) throw new NotFoundException('Artist not found');
    return artist;
  }

  assertEditable(status: ReleaseStatus) {
    if (!EDITABLE_STATUSES.includes(status)) {
      throw new BadRequestException(
        `This release has been submitted and can no longer be edited (status: ${status})`,
      );
    }
  }

  /**
   * Confirms an uploaded file may be attached here: it exists, belongs to the
   * caller, finished uploading, is the right kind, and is not already in use
   * somewhere else.
   */
  async assertAssetUsable(
    userId: string,
    assetId: string,
    kind: AssetKind,
    exclude: { trackId?: string; releaseId?: string } = {},
  ) {
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

    if (asset.kind !== kind) {
      throw new BadRequestException(
        `Expected ${kind.toLowerCase()} here, got ${asset.kind.toLowerCase()}`,
      );
    }

    if (asset.status !== 'UPLOADED') {
      throw new BadRequestException(
        'This file has not been confirmed yet. Call POST /media/{id}/confirm first.',
      );
    }

    // The schema enforces this with a unique constraint; checking first turns a
    // raw constraint violation into a message the app can show.
    if (kind === 'AUDIO') {
      const inUse = await this.prisma.track.findFirst({
        where: {
          audioAssetId: assetId,
          ...(exclude.trackId && { NOT: { id: exclude.trackId } }),
        },
        select: { id: true },
      });
      if (inUse) {
        throw new BadRequestException(
          'That audio file is already attached to another track',
        );
      }
    }

    if (kind === 'ARTWORK') {
      const inUse = await this.prisma.release.findFirst({
        where: {
          artworkAssetId: assetId,
          ...(exclude.releaseId && { NOT: { id: exclude.releaseId } }),
        },
        select: { id: true },
      });
      if (inUse) {
        throw new BadRequestException(
          'That artwork is already attached to another release',
        );
      }
    }
  }
}
