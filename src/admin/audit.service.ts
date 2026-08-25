import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AdminActionType,
  AdminTargetType,
} from '../generated/prisma/enums';

/** How much of a reason or note is kept. Long enough for any real one. */
const DETAIL_LIMIT = 1000;

/**
 * The record of who did what.
 *
 * One service rather than a write at each call site, so every admin action gets
 * the same shape and nothing is left out by being written in a hurry.
 *
 * Writes here never throw. An audit row failing must not take an approval down
 * with it — the decision is the thing the artist is waiting on, and losing a
 * log line is recoverable in a way that a 500 on a decision that already
 * happened is not. Failures are logged loudly instead.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(args: {
    adminUserId: string;
    action: AdminActionType;
    targetType: AdminTargetType;
    targetId: string;
    detail?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.adminAction.create({
        data: {
          adminUserId: args.adminUserId,
          action: args.action,
          targetType: args.targetType,
          targetId: args.targetId,
          detail: args.detail?.trim().slice(0, DETAIL_LIMIT) || null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to record ${args.action} on ${args.targetType} ${args.targetId} by ${args.adminUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Everything that has happened to one thing, newest first.
   *
   * The administrator is joined in by name rather than left as an id: the only
   * reason to read this is to find out who, and an id is not an answer.
   *
   * Reads fail soft for the same reason writes do, plus one more: this table is
   * newer than the pages that show it, so an environment whose schema has not
   * been pushed yet would otherwise 500 a release page over a missing history
   * panel. An empty trail is a worse answer than a real one and a much better
   * one than a broken page.
   */
  async forTarget(targetType: AdminTargetType, targetId: string, limit = 20) {
    const rows = await this.readRows(targetType, targetId, limit);
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      detail: row.detail,
      createdAt: row.createdAt,
      admin: {
        id: row.admin.id,
        name:
          [row.admin.firstName, row.admin.lastName].filter(Boolean).join(' ') ||
          row.admin.email,
      },
    }));
  }

  private async readRows(
    targetType: AdminTargetType,
    targetId: string,
    limit: number,
  ) {
    try {
      return await this.prisma.adminAction.findMany({
        where: { targetType, targetId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          action: true,
          detail: true,
          createdAt: true,
          admin: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to read the trail for ${targetType} ${targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }
}
