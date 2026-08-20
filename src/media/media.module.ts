import { Module } from '@nestjs/common';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageService } from './storage.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService, StorageService, MediaCleanupService],
  // StorageService is exported so the catalogue module can presign playback
  // URLs without going through the media controller.
  exports: [MediaService, StorageService],
})
export class MediaModule {}
