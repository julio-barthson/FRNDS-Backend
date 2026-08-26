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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import {
  CreateRosterArtistDto,
  UpdateRosterArtistDto,
} from './dto/roster-artist.dto';
import { RosterService } from './roster.service';

@ApiTags('label')
@ApiBearerAuth()
@Controller('label/artists')
export class RosterController {
  constructor(private readonly roster: RosterService) {}

  @ApiOperation({
    summary: "List the label's roster",
    description:
      'Every artist this label owns, with how many releases each has. Alphabetical.',
  })
  @Get()
  list(@CurrentUser('sub') userId: string) {
    return this.roster.list(userId);
  }

  @ApiOperation({ summary: 'Get one roster artist' })
  @Get(':id')
  findOne(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.roster.findOne(userId, id);
  }

  @ApiOperation({
    summary: 'Add an artist to the roster',
    description:
      'Creates the artist identity the label releases under. No login is created — a roster artist is metadata the label owns. Spotify and Apple Music profile links are accepted in place of raw ids.',
  })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateRosterArtistDto,
  ) {
    return this.roster.create(userId, dto);
  }

  @ApiOperation({
    summary: 'Update a roster artist',
    description: 'Renaming moves the public slug.',
  })
  @Patch(':id')
  update(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRosterArtistDto,
  ) {
    return this.roster.update(userId, id, dto);
  }

  @ApiOperation({
    summary: 'Remove an artist from the roster',
    description:
      'Refused once the artist has releases — the catalogue hangs off this row.',
  })
  @Delete(':id')
  remove(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.roster.remove(userId, id);
  }
}
