import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Positions } from '../decorators/positions.decorator';
import { AdminGuard } from './admin.guard';
import { QueueQueryDto, RejectReleaseDto } from './dto/review.dto';
import { ReviewService } from './review.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/releases')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @ApiOperation({
    summary: 'The review queue, or the whole catalogue',
    description:
      'Defaults to the queue: SUBMITTED and IN_REVIEW together, oldest submission first — everything waiting on a person. `scope=catalogue` widens it to every release whatever its status, newest first.',
  })
  @Get()
  queue(@Query() query: QueueQueryDto) {
    return this.review.queue(query);
  }

  @ApiOperation({
    summary: 'One release, in full',
    description:
      'The same shape the artist sees, plus the artist behind it. Artwork and audio come back as short-lived signed URLs so a reviewer can look and listen.',
  })
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.review.findOne(id);
  }

  @ApiOperation({
    summary: 'Take a release off the queue',
    description:
      'Moves SUBMITTED to IN_REVIEW so two reviewers do not work the same release. Idempotent.',
  })
  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  claim(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminUserId: string,
  ) {
    return this.review.claim(id, adminUserId);
  }

  // Reviewing is the whole job of a MODERATOR, and an ADMIN or SUPER_ADMIN can
  // do anything. FINANCE, SUPPORT and VIEWER can read the queue but not decide.
  @ApiOperation({ summary: 'Approve a release' })
  @Positions('SUPER_ADMIN', 'ADMIN', 'MODERATOR')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminUserId: string,
  ) {
    return this.review.approve(id, adminUserId);
  }

  @ApiOperation({
    summary: 'Send a release back',
    description:
      'The notes are shown to the artist verbatim and editing reopens immediately.',
  })
  @Positions('SUPER_ADMIN', 'ADMIN', 'MODERATOR')
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectReleaseDto,
    @CurrentUser('sub') adminUserId: string,
  ) {
    return this.review.reject(id, dto, adminUserId);
  }
}
