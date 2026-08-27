import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../media/storage.service';
import { AudioValidationService } from '../audio/audio-validation.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { ReleaseType } from '../generated/prisma/enums';
import { assertNoTypedFeature, normaliseContributors } from './billing';
import { CatalogueAccess } from './catalogue.access';
import { CreateReleaseDto, TrackInputDto } from './dto/create-release.dto';
import { QueryReleasesDto } from './dto/query-releases.dto';
import { SubmitReleaseDto } from './dto/submit-release.dto';
import { UpdateReleaseDto } from './dto/update-release.dto';
import {
  releaseInclude,
  releaseSummarySelect,
  toReleaseDetail,
  toReleaseSummary,
} from './release.mapper';

const DEFAULT_PAGE_SIZE = 20;

@Injectable()
export class ReleasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CatalogueAccess,
    private readonly storage: StorageService,
    private readonly audio: AudioValidationService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Creates the release and its tracks in one transaction. A single upload in
   * the app is one release of type SINGLE holding one track — the app never
   * has to show the word "release".
   */
  async create(userId: string, dto: CreateReleaseDto) {
    const scope = await this.access.scopeFor(userId);
    const artist = await this.access.resolveReleaseArtist(scope, dto.artistId);
    const type = resolveType(dto.type, dto.tracks.length);

    if (type === 'SINGLE' && dto.tracks.length !== 1) {
      throw new BadRequestException('A single must have exactly one track');
    }

    if (dto.artworkAssetId) {
      await this.access.assertAssetUsable(
        userId,
        dto.artworkAssetId,
        'ARTWORK',
      );
    }

    for (const track of dto.tracks) {
      if (track.audioAssetId) {
        await this.access.assertAssetUsable(
          userId,
          track.audioAssetId,
          'AUDIO',
        );
      }
    }

    assertNoDuplicateAssets(dto.tracks);

    // Caught here rather than at submission: the artist is still looking at the
    // field they typed it into, which is the only point the fix is cheap.
    assertNoTypedFeature(dto.title, 'release title');
    for (const track of dto.tracks) {
      assertNoTypedFeature(track.title, `title of "${track.title}"`);
    }

    // Billing defaults to the account doing the uploading, which is right for
    // almost every release and leaves the artist nothing to fill in. Sending a
    // list replaces it outright.
    const contributors = dto.contributors?.length
      ? normaliseContributors(dto.contributors)
      : [
          {
            name: artist.stageName,
            role: 'PRIMARY_ARTIST' as const,
            position: 0,
          },
        ];

    const release = await this.prisma.release.create({
      data: {
        artistId: artist.id,
        labelId: artist.labelId,
        title: dto.title.trim(),
        type,
        releaseDate: dto.releaseDate ? new Date(dto.releaseDate) : null,
        language: dto.language,
        primaryGenre: dto.primaryGenre,
        secondaryGenre: dto.secondaryGenre,
        cLine: dto.cLine,
        pLine: dto.pLine,
        artworkAssetId: dto.artworkAssetId,
        status: 'DRAFT',
        contributors: { create: contributors },
        tracks: {
          create: dto.tracks.map((track, index) => ({
            title: track.title.trim(),
            versionTitle: track.versionTitle,
            trackNumber: index + 1,
            explicit: track.explicit ?? false,
            lyrics: track.lyrics,
            audioAssetId: track.audioAssetId,
            status: track.audioAssetId ? 'PROCESSING' : 'PENDING_UPLOAD',
            ...(track.contributors?.length && {
              contributors: {
                create: normaliseContributors(track.contributors),
              },
            }),
          })),
        },
      },
      include: releaseInclude,
    });

    // Probing happens in the background; the artist gets the draft back now
    // and the track flips to READY or FAILED within seconds.
    for (const track of release.tracks) {
      if (track.audioAssetId) this.audio.enqueue(track.id);
    }

    return toReleaseDetail(release, this.storage);
  }

  /** The dashboard list. */
  async list(userId: string, query: QueryReleasesDto) {
    const scope = await this.access.scopeFor(userId);
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    // Intersected, never substituted. Spreading `query.artistId` over the scope
    // clause would have replaced it, letting any caller read another label's
    // catalogue by guessing an id. An out-of-scope filter yields an empty list,
    // which matches how a foreign release id reads as missing.
    const artistIds = query.artistId
      ? scope.artistIds.filter((id) => id === query.artistId)
      : scope.artistIds;

    const where = {
      // `in` rather than a single id: a label sees its whole roster here, and
      // an artist's own list is the one-element case of the same query.
      artistId: { in: artistIds },
      ...(query.status && { status: query.status }),
      ...(query.search && {
        OR: [
          { title: { contains: query.search, mode: 'insensitive' as const } },
          {
            tracks: {
              some: {
                title: {
                  contains: query.search,
                  mode: 'insensitive' as const,
                },
              },
            },
          },
        ],
      }),
    };

    const [total, releases] = await Promise.all([
      this.prisma.release.count({ where }),
      this.prisma.release.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: releaseSummarySelect,
      }),
    ]);

    const items = await Promise.all(
      releases.map((release) => toReleaseSummary(release, this.storage)),
    );

    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async findOne(userId: string, releaseId: string) {
    const release = await this.findOwned(userId, releaseId);
    return toReleaseDetail(release, this.storage);
  }

  async update(userId: string, releaseId: string, dto: UpdateReleaseDto) {
    const existing = await this.findWritable(userId, releaseId);
    this.access.assertEditable(existing.status);

    if (dto.artworkAssetId) {
      await this.access.assertAssetUsable(
        userId,
        dto.artworkAssetId,
        'ARTWORK',
        {
          releaseId,
        },
      );
    }

    if (dto.type && dto.type === 'SINGLE' && existing.tracks.length !== 1) {
      throw new BadRequestException(
        `A single must have exactly one track — this release has ${existing.tracks.length}`,
      );
    }

    if (dto.title !== undefined) {
      assertNoTypedFeature(dto.title, 'release title');
    }

    const release = await this.prisma.release.update({
      where: { id: releaseId },
      data: {
        ...(dto.title !== undefined && { title: dto.title.trim() }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.releaseDate !== undefined && {
          releaseDate: dto.releaseDate ? new Date(dto.releaseDate) : null,
        }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.primaryGenre !== undefined && {
          primaryGenre: dto.primaryGenre,
        }),
        ...(dto.secondaryGenre !== undefined && {
          secondaryGenre: dto.secondaryGenre,
        }),
        ...(dto.cLine !== undefined && { cLine: dto.cLine }),
        ...(dto.pLine !== undefined && { pLine: dto.pLine }),
        ...(dto.artworkAssetId !== undefined && {
          artworkAssetId: dto.artworkAssetId,
        }),
        // Replaced wholesale, like track contributors: the app sends the list
        // it is showing, which needs no diffing from a phone. An empty array
        // is a real instruction — it clears the billing — so the check is on
        // `undefined`, not on length.
        ...(dto.contributors !== undefined && {
          contributors: {
            deleteMany: {},
            ...(dto.contributors.length && {
              create: normaliseContributors(dto.contributors),
            }),
          },
        }),
        // Editing a rejected release puts it back in the artist's hands.
        ...(existing.status === 'REJECTED' && {
          status: 'DRAFT' as const,
          reviewNotes: null,
        }),
      },
      include: releaseInclude,
    });

    return toReleaseDetail(release, this.storage);
  }

  /**
   * Deletes a draft and its tracks. The uploaded files are left alone and the
   * daily media sweep collects them once nothing points at them — deleting
   * objects inline would strand the row if storage were briefly unreachable.
   */
  async remove(userId: string, releaseId: string) {
    const existing = await this.findWritable(userId, releaseId);
    this.access.assertEditable(existing.status);

    await this.prisma.release.delete({ where: { id: releaseId } });

    return { message: 'Release deleted' };
  }

  /**
   * Hands the release over for review. Nothing reaches a DSP in this phase, so
   * SUBMITTED means "with FRNDSHQ", never "live".
   */
  async submit(userId: string, releaseId: string, dto: SubmitReleaseDto) {
    // The DTO already rejects anything but true. Checked again here so the
    // rights claim cannot be skipped by calling this service from elsewhere.
    if (!dto.confirmRights) {
      throw new BadRequestException(
        'You must confirm you own or control the rights to this recording',
      );
    }

    const existing = await this.findWritable(userId, releaseId);
    this.access.assertEditable(existing.status);

    const problems = collectSubmissionProblems(existing);
    if (problems.length) {
      throw new BadRequestException(problems);
    }

    const now = new Date();
    const release = await this.prisma.release.update({
      where: { id: releaseId },
      data: {
        status: 'SUBMITTED',
        submittedAt: now,
        // dto.confirmRights is validated as true, so reaching here is the
        // artist's rights claim; the timestamp is the record of it.
        rightsConfirmedAt: now,
        reviewNotes: null,
      },
      include: releaseInclude,
    });

    const detail = await toReleaseDetail(release, this.storage);

    // Both sides of the hand-off, in one place. Awaited rather than fired and
    // forgotten so a failure is logged against this request — `notify` swallows
    // its own errors, so this cannot fail the submission.
    await this.notifications.notify({
      userId,
      type: 'RELEASE_SUBMITTED',
      title: 'Release submitted',
      body: `“${release.title}” is with our review team. We will let you know as soon as there is a decision.`,
      releaseId: release.id,
    });

    await this.notifications.notifyAdmins({
      type: 'REVIEW_QUEUE_NEW',
      title: 'New release to review',
      body: `${detail.displayArtist || 'An artist'} submitted “${release.title}”.`,
      releaseId: release.id,
    });

    return detail;
  }

  /** Scoped to the caller's artist, so someone else's id reads as missing. */
  private async findOwned(userId: string, releaseId: string) {
    const scope = await this.access.scopeFor(userId);

    const release = await this.prisma.release.findFirst({
      where: { id: releaseId, artistId: { in: scope.artistIds } },
      include: releaseInclude,
    });

    if (!release) throw new NotFoundException('Release not found');
    return release;
  }

  /**
   * The same lookup, for the paths that then change something.
   *
   * Separate rather than a flag so a new mutation cannot quietly inherit read
   * access by calling the wrong one — a VIEWER seat can reach every release
   * here, and only this refuses them.
   */
  private async findWritable(userId: string, releaseId: string) {
    const scope = await this.access.scopeFor(userId);

    const release = await this.prisma.release.findFirst({
      where: { id: releaseId, artistId: { in: scope.artistIds } },
      include: releaseInclude,
    });

    if (!release) throw new NotFoundException('Release not found');
    this.access.assertWritable(scope, release.artistId);
    return release;
  }
}

/** 1 track is a single, 2–6 an EP, more an album. */
function resolveType(
  requested: ReleaseType | undefined,
  trackCount: number,
): ReleaseType {
  if (requested) return requested;
  if (trackCount === 1) return 'SINGLE';
  return trackCount <= 6 ? 'EP' : 'ALBUM';
}

function assertNoDuplicateAssets(tracks: TrackInputDto[]) {
  const ids = tracks
    .map((track) => track.audioAssetId)
    .filter((id): id is string => Boolean(id));

  if (new Set(ids).size !== ids.length) {
    throw new BadRequestException(
      'The same audio file cannot be used for two tracks',
    );
  }
}

/**
 * Everything wrong with the release, in one response. Returning them one at a
 * time turns submission into a guessing game on a phone.
 */
function collectSubmissionProblems(release: {
  artworkAssetId: string | null;
  primaryGenre: string | null;
  contributors: { role: string }[];
  tracks: { title: string; audioAssetId: string | null; status: string }[];
}): string[] {
  const problems: string[] = [];

  if (!release.artworkAssetId) {
    problems.push('Cover artwork is required');
  }

  if (!release.primaryGenre) {
    problems.push('A primary genre is required');
  }

  // A release with only featured artists on it has nobody to bill it to, and
  // no artist page for it to appear on. Stores reject it outright.
  if (!release.contributors.some((row) => row.role === 'PRIMARY_ARTIST')) {
    problems.push('At least one primary artist is required');
  }

  if (release.tracks.length === 0) {
    problems.push('At least one track is required');
  }

  for (const track of release.tracks) {
    if (!track.audioAssetId) {
      problems.push(`"${track.title}" has no audio file`);
    } else if (track.status === 'FAILED') {
      problems.push(
        `"${track.title}" failed audio checks and must be replaced`,
      );
    } else if (track.status !== 'READY') {
      problems.push(`"${track.title}" is still processing`);
    }
  }

  return problems;
}
