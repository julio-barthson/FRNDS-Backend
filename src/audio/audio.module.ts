import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AudioProbeService } from './audio-probe.service';
import { AudioValidationService } from './audio-validation.service';

@Module({
  // MediaModule for StorageService: the probe reads the file through a
  // presigned URL. NotificationsModule so a failed check reaches a person —
  // before this, a track went to FAILED and waited to be noticed.
  imports: [MediaModule, NotificationsModule],
  providers: [AudioProbeService, AudioValidationService],
  exports: [AudioValidationService],
})
export class AudioModule {}
