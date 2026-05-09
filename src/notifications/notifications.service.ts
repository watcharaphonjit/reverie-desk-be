import { Injectable, Logger, NotFoundException } from '@nestjs/common';
// (decorator on NotificationsModule, not service — see notifications.module.ts)
import {
  Notification,
  NotificationChannel,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { NotificationProviderRegistry } from './providers/registry';

export interface NotifyInput {
  userId?: string | null;
  branchId?: string | null;
  title: string;
  message: string;
  type: NotificationType;
  channel?: NotificationChannel;
  metadata?: Prisma.InputJsonValue | null;
  /**
   * Optional dedupe fingerprint. When provided, a duplicate insert is
   * caught (Postgres unique violation on `dedupeKey`) and resolved as
   * "already-posted" — the existing row is returned. This is what
   * automation rules use to be safely idempotent.
   */
  dedupeKey?: string | null;
}

export interface NotifyResult {
  notification: Notification;
  /** True if a new row was created; false if the dedupeKey already existed. */
  created: boolean;
}

/**
 * Composes a stable dedupe fingerprint. Rules pass `entityType:entityId`
 * to scope dedup to a single business object; `bucket` is a string
 * representation of the time slice (date for daily rules, hourly stamp
 * for hourly rules, etc.).
 */
export function buildDedupeKey(parts: {
  type: NotificationType;
  userId?: string | null;
  entityType?: string;
  entityId?: string;
  bucket?: string;
}): string {
  const segments = [
    parts.type,
    parts.userId ?? '*',
    parts.entityType ?? '*',
    parts.entityId ?? '*',
    parts.bucket ?? '*',
  ];
  return segments.join('|');
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: NotificationProviderRegistry,
  ) {}

  // ───────────────────────── notify (internal) ─────────────────────────

  /**
   * Post a notification. The IN_APP row is the system of record; if the
   * channel is EMAIL or SMS the row still gets created (channel field
   * indicates intent) and the corresponding provider is invoked
   * fire-and-forget. Failures during dispatch are logged but never
   * thrown — callers (rules, hooks) should never be blocked on a
   * downstream send.
   *
   * Idempotency: if `dedupeKey` is provided and a row already exists
   * with that key, this returns `{ created: false, notification: <existing> }`.
   */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    const channel = input.channel ?? NotificationChannel.IN_APP;
    try {
      const created = await this.prisma.notification.create({
        data: {
          userId: input.userId ?? null,
          branchId: input.branchId ?? null,
          title: input.title,
          message: input.message,
          type: input.type,
          channel,
          metadata: input.metadata ?? Prisma.DbNull,
          dedupeKey: input.dedupeKey ?? null,
        },
      });
      // Dispatch outside the create — failure here must not undo the row.
      void this.dispatch(created);
      return { notification: created, created: true };
    } catch (err) {
      // Unique-violation on dedupeKey → return existing row.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        input.dedupeKey
      ) {
        const existing = await this.prisma.notification.findUnique({
          where: { dedupeKey: input.dedupeKey },
        });
        if (existing) return { notification: existing, created: false };
      }
      throw err;
    }
  }

  /**
   * Bulk variant — post the same notification to many recipients with
   * unique dedupe keys per user. Returns created count and skipped count.
   */
  async notifyMany(
    userIds: string[],
    base: Omit<NotifyInput, 'userId'> & { dedupeKeyPrefix?: string },
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;
    for (const userId of new Set(userIds)) {
      const dedupeKey =
        base.dedupeKeyPrefix !== undefined
          ? `${base.dedupeKeyPrefix}|${userId}`
          : null;
      const result = await this.notify({
        ...base,
        userId,
        dedupeKey,
      });
      if (result.created) created++;
      else skipped++;
    }
    return { created, skipped };
  }

  private dispatch(notification: Notification): void {
    const provider = this.providers.resolve(notification.channel);
    if (!provider) return;
    provider
      .dispatch({
        notificationId: notification.id,
        userId: notification.userId,
        branchId: notification.branchId,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        metadata:
          (notification.metadata as Record<string, unknown> | null) ?? null,
      })
      .catch((err: unknown) => {
        this.logger.error(
          `Dispatch failed for notification ${notification.id} (${notification.channel}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /**
   * Re-dispatch by id. Used by the BullMQ notification worker when
   * dispatch was queued for async/durable delivery instead of running
   * inline. Returns true if the row was found and dispatched.
   */
  async dispatchById(id: string): Promise<boolean> {
    const row = await this.prisma.notification.findUnique({ where: { id } });
    if (!row) return false;
    this.dispatch(row);
    return true;
  }

  // ───────────────────────── public API ─────────────────────────

  async list(
    user: AuthenticatedUser,
    query: NotificationQueryDto,
  ): Promise<PaginatedResult<Notification>> {
    const where: Prisma.NotificationWhereInput = {
      userId: user.id,
      ...(query.unreadOnly ? { isRead: false } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  async unreadCount(user: AuthenticatedUser): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId: user.id, isRead: false },
    });
    return { count };
  }

  async markRead(user: AuthenticatedUser, id: string): Promise<Notification> {
    const existing = await this.prisma.notification.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== user.id) {
      throw new NotFoundException('Notification not found');
    }
    if (existing.isRead) return existing;
    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllRead(user: AuthenticatedUser): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { userId: user.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: res.count };
  }

  async create(
    actor: AuthenticatedUser,
    dto: CreateNotificationDto,
  ): Promise<Notification> {
    const result = await this.notify({
      userId: dto.userId,
      branchId: dto.branchId,
      title: dto.title,
      message: dto.message,
      type: dto.type,
      channel: dto.channel,
      metadata: dto.metadata ? (dto.metadata as Prisma.InputJsonValue) : null,
    });
    this.logger.log(
      `User ${actor.id} created notification ${result.notification.id}`,
    );
    return result.notification;
  }
}
