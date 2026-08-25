import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Positions } from '../decorators/positions.decorator';
import { AdminGuard } from './admin.guard';
import { AdminsService } from './admins.service';
import {
  CreateAdminDto,
  SuspendAdminDto,
  UpdateAdminDto,
} from './dto/admins.dto';

/**
 * Administrators.
 *
 * `SUPER_ADMIN` on the whole controller rather than per route: there is no
 * read here that is safe for everyone. A list of who holds console access, and
 * what each of them can do, is itself the map of how to get in.
 *
 * `:id` is the **user** id throughout, not the Admin row's — every other page
 * in the console is keyed that way, and the self-checks compare against the
 * token's subject, which is a user id.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Positions('SUPER_ADMIN')
@Controller('admin/admins')
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @ApiOperation({ summary: 'Everyone with console access' })
  @Get()
  list() {
    return this.admins.list();
  }

  @ApiOperation({
    summary: 'Create an administrator',
    description:
      'Returns a generated password once. It is hashed before storage and cannot be read back — pass it on out of band, and they are made to change it at first sign-in.',
  })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateAdminDto,
    @CurrentUser('sub') actingUserId: string,
  ) {
    return this.admins.create(dto, actingUserId);
  }

  @ApiOperation({
    summary: 'Change what an administrator can do',
    description:
      'Refused for your own account, and for the last active super admin.',
  })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminDto,
    @CurrentUser('sub') actingUserId: string,
  ) {
    return this.admins.update(id, dto, actingUserId);
  }

  @ApiOperation({
    summary: 'Issue a new password',
    description: 'Same one-time hand-off as creation. Signs them out.',
  })
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actingUserId: string,
  ) {
    return this.admins.resetPassword(id, actingUserId);
  }

  @ApiOperation({
    summary: 'Suspend an administrator',
    description:
      'The way console access is removed. Deleting the row would leave a user with the ADMIN role and no position, which the guard reads as a broken account rather than a revoked one.',
  })
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendAdminDto,
    @CurrentUser('sub') actingUserId: string,
  ) {
    return this.admins.suspend(id, dto, actingUserId);
  }

  @ApiOperation({ summary: 'Restore console access' })
  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  reinstate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('sub') actingUserId: string,
  ) {
    return this.admins.reinstate(id, actingUserId);
  }
}
