import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';

/**
 * Label-side operations: the roster, and the dashboard over it. Label profile
 * edits still live in `AuthService` alongside the artist ones, and user seats —
 * inviting a person to a label's catalogue — are a later phase.
 *
 * MediaModule for StorageService: the dashboard signs artwork URLs the same
 * way the catalogue list does.
 */
@Module({
  imports: [MediaModule],
  controllers: [RosterController, OverviewController],
  providers: [RosterService, OverviewService],
})
export class LabelModule {}
