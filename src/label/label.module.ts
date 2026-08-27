import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { MediaModule } from '../media/media.module';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';
import { ArtistSeatsController, SeatsController } from './seats.controller';
import { SeatsService } from './seats.service';

/**
 * Label-side operations: the roster, and the dashboard over it. Label profile
 * edits still live in `AuthService` alongside the artist ones, and user seats —
 * inviting a person to one roster artist — now live as ArtistSeat.
 *
 * MediaModule for StorageService: the dashboard signs artwork URLs the same
 * way the catalogue list does.
 */
@Module({
  imports: [MediaModule, MailModule],
  controllers: [
    RosterController,
    OverviewController,
    ArtistSeatsController,
    SeatsController,
  ],
  providers: [RosterService, OverviewService, SeatsService],
})
export class LabelModule {}
