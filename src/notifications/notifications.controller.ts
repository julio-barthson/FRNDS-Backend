import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { NotificationsQueryDto } from './dto/notifications.dto';
import { NotificationsService } from './notifications.service';

/**
 * One person's notifications.
 *
 * Not under `/admin`, and not guarded by `AdminGuard`: artists, labels and
 * administrators all have a bell, and everything here is scoped to the token's
 * own subject. There is no route that reads somebody else's.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiOperation({
    summary: 'Your notifications',
    description: 'Newest first, with the unread count alongside.',
  })
  @Get()
  list(
    @CurrentUser('sub') userId: string,
    @Query() query: NotificationsQueryDto,
  ) {
    return this.notifications.list(userId, query);
  }

  @ApiOperation({
    summary: 'Just the badge',
    description: 'The unread count on its own, for polling the bell.',
  })
  @Get('unread-count')
  unreadCount(@CurrentUser('sub') userId: string) {
    return this.notifications.unreadCount(userId);
  }

  @ApiOperation({ summary: 'Mark one as read' })
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(userId, id);
  }

  @ApiOperation({ summary: 'Clear the badge' })
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser('sub') userId: string) {
    return this.notifications.markAllRead(userId);
  }
}
