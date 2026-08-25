import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { CreateReleaseDto, TrackInputDto } from './dto/create-release.dto';
import { QueryReleasesDto } from './dto/query-releases.dto';
import { ReorderTracksDto } from './dto/reorder-tracks.dto';
import { SubmitReleaseDto } from './dto/submit-release.dto';
import { UpdateReleaseDto } from './dto/update-release.dto';
import { UpdateTrackDto } from './dto/update-track.dto';
import { ReleasesService } from './releases.service';
import { TracksService } from './tracks.service';

@ApiTags('catalogue')
@ApiBearerAuth()
@Controller('releases')
export class CatalogueController {
  constructor(
    private readonly releases: ReleasesService,
    private readonly tracks: TracksService,
  ) {}

  @ApiOperation({
    summary: 'Create a release',
    description:
      'One upload in the app is one release with one track. Audio can be attached now or patched onto the track after the file finishes uploading.',
  })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateReleaseDto) {
    return this.releases.create(userId, dto);
  }

  @ApiOperation({
    summary: "List this artist's releases",
    description: 'The dashboard feed. Newest first, paginated.',
  })
  @Get()
  list(@CurrentUser('sub') userId: string, @Query() query: QueryReleasesDto) {
    return this.releases.list(userId, query);
  }

  @ApiOperation({ summary: 'Get one release with its tracks' })
  @Get(':id')
  findOne(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.releases.findOne(userId, id);
  }

  @ApiOperation({
    summary: 'Update a release',
    description:
      'Drafts and rejected releases only. Editing a rejected release moves it back to draft.',
  })
  @Patch(':id')
  update(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReleaseDto,
  ) {
    return this.releases.update(userId, id, dto);
  }

  @ApiOperation({ summary: 'Delete a draft release' })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.releases.remove(userId, id);
  }

  @ApiOperation({
    summary: 'Submit a release for review',
    description:
      'Requires artwork, a primary genre, and audio on every track. Returns every missing item at once. Submitted means received by FRNDSHQ — nothing reaches a streaming platform in this phase.',
  })
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitReleaseDto,
  ) {
    return this.releases.submit(userId, id, dto);
  }

  // ── Tracks ────────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Add a track to a draft EP or album' })
  @Post(':id/tracks')
  @HttpCode(HttpStatus.CREATED)
  addTrack(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TrackInputDto,
  ) {
    return this.tracks.addTrack(userId, id, dto);
  }

  // Declared above `:id/tracks/:trackId` so `order` is read as this route and
  // not as a track id — `ParseUUIDPipe` would otherwise reject it as malformed
  // rather than falling through.
  @ApiOperation({
    summary: 'Set the running order',
    description:
      'Takes every track id on the release, in order. Renumbers `trackNumber` from 1 and returns the release.',
  })
  @Patch(':id/tracks/order')
  reorderTracks(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderTracksDto,
  ) {
    return this.tracks.reorderTracks(userId, id, dto);
  }

  @ApiOperation({
    summary: 'Update a track',
    description:
      'This is where a confirmed audio upload gets attached: `{ "audioAssetId": "..." }`. Sending `contributors` replaces the whole list.',
  })
  @Patch(':id/tracks/:trackId')
  updateTrack(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('trackId', ParseUUIDPipe) trackId: string,
    @Body() dto: UpdateTrackDto,
  ) {
    return this.tracks.updateTrack(userId, id, trackId, dto);
  }

  @ApiOperation({ summary: 'Remove a track from a draft' })
  @Delete(':id/tracks/:trackId')
  @HttpCode(HttpStatus.OK)
  removeTrack(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('trackId', ParseUUIDPipe) trackId: string,
  ) {
    return this.tracks.removeTrack(userId, id, trackId);
  }
}
