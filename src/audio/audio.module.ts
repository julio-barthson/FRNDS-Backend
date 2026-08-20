import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { AudioProbeService } from './audio-probe.service';
import { AudioValidationService } from './audio-validation.service';

@Module({
  // For StorageService: the probe reads the file through a presigned URL.
  imports: [MediaModule],
  providers: [AudioProbeService, AudioValidationService],
  exports: [AudioValidationService],
})
export class AudioModule {}
