import { Module } from '@nestjs/common';
import { AudioModule } from '../audio/audio.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CatalogueAccess } from './catalogue.access';
import { ArtistsController } from './artists.controller';
import { CatalogueController } from './catalogue.controller';
import { ReleasesService } from './releases.service';
import { TracksService } from './tracks.service';

@Module({
  // MediaModule for StorageService (presigned artwork and audio URLs),
  // AudioModule to kick off validation when a file is attached.
  // NotificationsModule so a submission tells the artist we have it and puts
  // it in front of the reviewers, rather than landing silently in a queue.
  imports: [MediaModule, AudioModule, NotificationsModule],
  controllers: [CatalogueController, ArtistsController],
  providers: [ReleasesService, TracksService, CatalogueAccess],
  exports: [ReleasesService],
})
export class CatalogueModule {}
