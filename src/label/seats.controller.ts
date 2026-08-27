import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AcceptSeatDto, InviteSeatDto } from './dto/seat.dto';
import { SeatsService } from './seats.service';

@ApiTags('label')
@ApiBearerAuth()
@Controller('label/artists/:artistId/seats')
export class ArtistSeatsController {
  constructor(private readonly seats: SeatsService) {}

  @ApiOperation({
    summary: 'Who has access to this artist',
    description:
      'Outstanding invitations and accepted seats. Revoked ones are not listed.',
  })
  @Get()
  list(
    @CurrentUser('sub') userId: string,
    @Param('artistId', ParseUUIDPipe) artistId: string,
  ) {
    return this.seats.list(userId, artistId);
  }

  @ApiOperation({
    summary: 'Invite someone to this artist',
    description:
      'Emails a six-digit code, good for seven days. The invitee signs in with that address and enters the code. Re-inviting the same address replaces the outstanding code rather than issuing a second one.',
  })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  invite(
    @CurrentUser('sub') userId: string,
    @Param('artistId', ParseUUIDPipe) artistId: string,
    @Body() dto: InviteSeatDto,
  ) {
    return this.seats.invite(userId, artistId, dto);
  }
}

@ApiTags('label')
@ApiBearerAuth()
@Controller('seats')
export class SeatsController {
  constructor(private readonly seats: SeatsService) {}

  @ApiOperation({
    summary: 'Artists shared with me',
    description: 'The seats this account holds. Empty for most people.',
  })
  @Get('mine')
  mine(@CurrentUser('sub') userId: string) {
    return this.seats.mine(userId);
  }

  @ApiOperation({
    summary: 'Accept an invitation',
    description:
      "Matched on the signed-in account's own email address, so the code alone is not enough — it has to be redeemed from the mailbox it was sent to.",
  })
  // Six digits is 1,000,000 possibilities and this is not rate-limited by an
  // account lookup the way login is, so the guess budget is set here.
  @Throttle({ default: { ttl: 900_000, limit: 10 } })
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser('sub') userId: string, @Body() dto: AcceptSeatDto) {
    return this.seats.accept(userId, dto.code);
  }

  @ApiOperation({
    summary: 'Revoke a seat',
    description:
      'Label owners only. Takes effect on the holder’s next request.',
  })
  @Delete(':id')
  revoke(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.seats.revoke(userId, id);
  }
}
