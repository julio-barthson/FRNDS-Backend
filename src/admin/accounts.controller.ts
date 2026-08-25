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
import { AccountsService } from './accounts.service';
import { AdminGuard } from './admin.guard';
import { AccountsQueryDto, SuspendAccountDto } from './dto/accounts.dto';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @ApiOperation({
    summary: 'Artist and label accounts',
    description:
      'Newest first. Administrators are not included — they have their own page.',
  })
  @Get()
  list(@Query() query: AccountsQueryDto) {
    return this.accounts.list(query);
  }

  @ApiOperation({
    summary: 'One account, with its catalogue',
    description: 'Keyed by user id, not artist id, so a label resolves too.',
  })
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.findOne(id);
  }

  // Locking someone out of their own catalogue is a heavier act than sending a
  // release back, so it sits above MODERATOR. Everyone else can still read the
  // page and see that an account is suspended.
  @ApiOperation({
    summary: 'Suspend an account',
    description:
      'Takes effect immediately — the status is re-checked on every request — and the reason is shown to them at sign-in.',
  })
  @Positions('SUPER_ADMIN', 'ADMIN')
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendAccountDto,
    @CurrentUser('sub') adminUserId: string,
  ) {
    return this.accounts.suspend(id, dto, adminUserId);
  }

  @ApiOperation({ summary: 'Lift a suspension' })
  @Positions('SUPER_ADMIN', 'ADMIN')
  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  reinstate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') adminUserId: string,
  ) {
    return this.accounts.reinstate(id, adminUserId);
  }
}
