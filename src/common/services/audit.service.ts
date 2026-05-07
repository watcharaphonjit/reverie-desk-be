import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditContext {
  actorUserId: string | null;
  branchId: string | null;
  entityType: string;
  entityId: string;
  action: AuditAction;
  payload?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Writes immutable audit trail records. Failures are logged but never thrown,
 * so business writes are never lost just because audit logging hiccups.
 *
 * For multi-step business writes, prefer passing the {@link Prisma.TransactionClient}
 * via {@link recordWith} so the audit row commits or rolls back with the work.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(ctx: AuditContext): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toData(ctx) });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${ctx.entityType}:${ctx.entityId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async recordWith(
    tx: Prisma.TransactionClient,
    ctx: AuditContext,
  ): Promise<void> {
    await tx.auditLog.create({ data: this.toData(ctx) });
  }

  private toData(ctx: AuditContext): Prisma.AuditLogCreateInput {
    return {
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      action: ctx.action,
      payload: ctx.payload,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      ...(ctx.actorUserId
        ? { actor: { connect: { id: ctx.actorUserId } } }
        : {}),
      ...(ctx.branchId ? { branch: { connect: { id: ctx.branchId } } } : {}),
    };
  }
}
