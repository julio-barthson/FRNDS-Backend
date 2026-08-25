import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AdminsController } from './admins.controller';
import { AdminsService } from './admins.service';
import { AuditService } from './audit.service';
import { ReviewController } from './review.controller';
import { ReviewService } from './review.service';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Everything behind `/admin`.
 *
 * Guarded per-controller with `AdminGuard` rather than globally: the app's only
 * global guards are authentication and rate limiting, and adding a third that
 * every non-admin route has to opt out of would invert the default for the
 * whole API.
 */
@Module({
  imports: [
    // MediaModule for StorageService — a reviewer has to see the artwork at
    // full size and hear the master, both of which are signed URLs.
    MediaModule,
    // AuthModule for TokenService. Suspending an account and changing an
    // admin's position both have to end the sessions they were granted under,
    // or the change waits for a token to expire before it means anything.
    AuthModule,
    // NotificationsModule so a decision reaches the artist. Without it the
    // review notes exist only for whoever next opens the release.
    NotificationsModule,
  ],
  controllers: [
    ReviewController,
    StatsController,
    AccountsController,
    AdminsController,
  ],
  providers: [
    ReviewService,
    StatsService,
    AccountsService,
    AdminsService,
    AuditService,
  ],
})
export class AdminModule {}
