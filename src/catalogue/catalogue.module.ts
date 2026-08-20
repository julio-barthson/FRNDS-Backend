import { Module } from '@nestjs/common';
import { AudioModule } from '../audio/audio.module';
import { MediaModule } from '../media/media.module';
import { CatalogueAccess } from './catalogue.access';
import { CatalogueController } from './catalogue.controller';
import { ReleasesService } from './releases.service';
import { TracksService } from './tracks.service';

@Module({
  // MediaModule for StorageService (presigned artwork and audio URLs),
  // AudioModule to kick off validation when a file is attached.
  imports: [MediaModule, AudioModule],
  controllers: [CatalogueController],
  providers: [ReleasesService, TracksService, CatalogueAccess],
  exports: [ReleasesService],
})
export class CatalogueModule {}
