import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import type { NotificationType } from '../generated/prisma/enums';
import { NotificationsQueryDto } from './dto/notifications.dto';
import { notificationEmail } from './notification.templates';

const DEFAULT_PAGE_SIZE = 20;

export interface NotifyArgs {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  releaseId?: string | null;
  /**
   * Whether this one is worth an email as well. In-app is always written; mail
   * is for the things a person would want to hear about while away from the
   * app, and is skipped for the noisier admin-facing types.
   */
  email?: boolean;
}

/**
 * Telling people what happened.
 *
 * The row goes in first and the mail goes out after, deliberately in that
 * order: the centre is the record and the email is a copy. If mail fails — and
 * it currently always does, because the sender domain does not resolve — the
 * artist can still open the app and find out why their release came back.
 *
 * Nothing here throws. A notification is a side effect of a decision that has
 * already happened; failing the approve because the email bounced would be
 * strictly worse than a missing notification.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async notify(args: NotifyArgs): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          userId: args.userId,
          type: args.type,
          title: args.title,
          body: args.body,
          releaseId: args.releaseId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ${args.type} for ${args.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Deliberately falls through: if the row failed, the email is the only
      // chance this person has of hearing about it.
    }

    if (args.email === false) return;

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: args.userId },
        select: {
          email: true,
          firstName: true,
          emailNotifications: true,
          artist: { select: { stageName: true } },
        },
      });

      // An opt-out silences mail only. The in-app record above is not optional.
      if (!user || !user.emailNotifications) return;

      const name = user.artist?.stageName ?? user.firstName ?? '';

      await this.mail.sendMail({
        toEmail: user.email,
        toName: name || undefined,
        subject: args.title,
        html: notificationEmail(name, args.title, args.body),
      });
    } catch (error) {
      this.logger.error(
        `Failed to email ${args.type} to ${args.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Fans one notification out to every administrator.
   *
   * No email: a reviewer opens the console to work, and a message per
   * submission would be a mailbox nobody reads. The bell is the right surface
   * for this, and a digest is a later decision.
   */
  async notifyAdmins(
    args: Omit<NotifyArgs, 'userId' | 'email'>,
  ): Promise<void> {
    const admins = await this.prisma.user
      .findMany({
        where: { role: 'ADMIN', isDeleted: false, accountStatus: 'ACTIVE' },
        select: { id: true },
      })
      .catch(() => []);

    await Promise.all(
      admins.map((admin) =>
        this.notify({ ...args, userId: admin.id, email: false }),
      ),
    );
  }

  /** Newest first. The only order a notification list is ever read in. */
  async list(userId: string, query: NotificationsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const where = {
      userId,
      ...(query.unreadOnly && { readAt: null }),
    };

    const [total, unread, items] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items,
      unread,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /** Just the badge. Cheap enough to poll. */
  async unreadCount(userId: string) {
    const unread = await this.prisma.notification.count({
      where: { userId, readAt: null },
    });
    return { unread };
  }

  async markRead(userId: string, notificationId: string) {
    // Scoped by userId in the where, so another person's id reads as missing
    // rather than as forbidden — the same rule the catalogue follows.
    const result = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      const exists = await this.prisma.notification.findFirst({
        where: { id: notificationId, userId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Notification not found');
      // Already read. Marking it again is not an error.
    }

    return this.unreadCount(userId);
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });

    return { unread: 0 };
  }
}
