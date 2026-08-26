import { Module } from '@nestjs/common';
import { RosterController } from './roster.controller';
import { RosterService } from './roster.service';

/**
 * Label-side operations. Only the roster today; label profile edits still live
 * in `AuthService` alongside the artist ones, and user seats — inviting a
 * person to a label's catalogue — are a later phase.
 */
@Module({
  controllers: [RosterController],
  providers: [RosterService],
})
export class LabelModule {}
