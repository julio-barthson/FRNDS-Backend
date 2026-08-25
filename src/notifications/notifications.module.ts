import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Exported rather than kept private, because the events worth telling someone
 * about happen elsewhere — a submission in `catalogue`, a decision in `admin`.
 * Those modules import this one and call `notify`.
 */
@Module({
  imports: [MailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
