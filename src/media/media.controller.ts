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
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../decorators/current-user.decorator';
import { AssetKind } from '../generated/prisma/enums';
import { CreateUploadUrlDto } from './dto/create-upload-url.dto';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @ApiOperation({
    summary: 'Get a presigned upload URL',
    description: [
      'Three-step upload:',
      '1. Call this endpoint with the file kind, mime type and size.',
      '2. PUT the raw file to `uploadUrl`, sending the `headers` returned here. Do not send an Authorization header on that request.',
      '3. Call `POST /media/{id}/confirm`.',
      'The file never passes through this API.',
    ].join(' '),
  })
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  @Post('upload-url')
  @HttpCode(HttpStatus.CREATED)
  createUploadUrl(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateUploadUrlDto,
  ) {
    return this.mediaService.createUploadUrl(userId, dto);
  }

  @ApiOperation({
    summary: 'Confirm an upload finished',
    description:
      'Verifies the object exists in storage and matches the declared size, then marks it usable. Safe to call twice.',
  })
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mediaService.confirmUpload(userId, id);
  }

  @ApiOperation({
    summary: 'Get a short-lived download URL',
    description:
      'Expires in 5 minutes — fetch it when the artist plays the track or opens the artwork, not at list time.',
  })
  @Get(':id/url')
  getUrl(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mediaService.getDownloadUrl(userId, id);
  }

  @ApiOperation({ summary: "List this account's uploaded files" })
  @ApiQuery({ name: 'kind', enum: AssetKind, required: false })
  @Get()
  list(@CurrentUser('sub') userId: string, @Query('kind') kind?: AssetKind) {
    return this.mediaService.listForUser(userId, kind);
  }

  @ApiOperation({
    summary: 'Delete a file',
    description:
      'Allowed while the release is still a draft. Files on submitted releases cannot be removed here.',
  })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.mediaService.deleteAsset(userId, id);
  }
}
