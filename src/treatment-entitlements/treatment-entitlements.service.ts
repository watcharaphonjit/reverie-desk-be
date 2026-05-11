import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  AuditAction,
  Prisma,
  SalesOrderStatus,
  TreatmentEntitlement,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { assertBranchAccess } from '../common/authz/branch-scope';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Shape returned to API clients. `remainingSessions` is always derived
 * (`total - consumed`) so callers never have to compute it client-side.
 */
export interface EntitlementView {
  id: string;
  customerId: string;
  serviceId: string;
  serviceName: string;
  serviceCode: string;
  salesOrderItemId: string;
  salesOrderId: string;
  salesOrderNo: string;
  salesOrderStatus: SalesOrderStatus;
  totalSessions: number;
  consumedSessions: number;
  remainingSessions: number;
  activatedAt: Date;
  expiredAt: Date | null;
  isExpired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const ENTITLEMENT_INCLUDE = {
  service: { select: { id: true, code: true, name: true } },
  salesOrderItem: {
    select: {
      salesOrder: {
        select: {
          id: true,
          orderNo: true,
          status: true,
        },
      },
    },
  },
} satisfies Prisma.TreatmentEntitlementInclude;

type EntitlementWithService = Prisma.TreatmentEntitlementGetPayload<{
  include: typeof ENTITLEMENT_INCLUDE;
}>;

/**
 * Treatment-entitlement engine.
 *
 * Public surface (controller-facing):
 *   - listForCustomer / findOne          read
 *   - consumeForAppointment              redeem one session, idempotent
 *   - expire                             admin-side soft expire
 *
 * Internal helpers (called by other services within their own
 * transactions — never call the public methods from a tx):
 *   - createForPaidOrderWith             mint at first PAID transition
 *   - assertBookable                     validate at appointment booking
 *   - tryConsumeAppointmentWith          atomic raw-SQL drawdown helper
 */
@Injectable()
export class TreatmentEntitlementsService {
  private readonly logger = new Logger(TreatmentEntitlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ────────────────────── Reads ──────────────────────

  async listForCustomer(
    user: AuthenticatedUser,
    customerId: string,
  ): Promise<EntitlementView[]> {
    // Branch-scope by way of the customer's currentBranch. Unrestricted
    // roles see across branches; CS/doctors see only their own.
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, currentBranchId: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    assertBranchAccess(user, customer.currentBranchId);

    const rows = await this.prisma.treatmentEntitlement.findMany({
      where: { customerId },
      include: ENTITLEMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  async findOne(user: AuthenticatedUser, id: string): Promise<EntitlementView> {
    const row = await this.loadOrThrow(id);
    // Defer branch-scope to the entitlement's customer's current branch.
    const customer = await this.prisma.customer.findUnique({
      where: { id: row.customerId },
      select: { currentBranchId: true },
    });
    assertBranchAccess(user, customer?.currentBranchId ?? null);
    return toView(row);
  }

  // ────────────────────── Mutations ──────────────────────

  /**
   * Idempotently redeem one session for the given appointment.
   *
   * The full sequence is wrapped in a `$transaction` because we touch
   * three related rows (appointment stamp, entitlement counter, audit
   * row) and they must commit atomically. The atomic-decrement guard
   * lives in `tryConsumeAppointmentWith` (raw SQL UPDATE … WHERE
   * consumed < total) so over-consumption is impossible even under
   * concurrent calls.
   */
  async consumeForAppointment(
    user: AuthenticatedUser,
    appointmentId: string,
    note?: string,
  ): Promise<EntitlementView> {
    return this.prisma.$transaction(async (tx) => {
      const appt = await tx.appointment.findUnique({
        where: { id: appointmentId },
        select: {
          id: true,
          branchId: true,
          customerId: true,
          serviceId: true,
          status: true,
          entitlementId: true,
          entitlementConsumedAt: true,
        },
      });
      if (!appt) throw new NotFoundException('Appointment not found');
      assertBranchAccess(user, appt.branchId);

      if (!appt.entitlementId) {
        throw new BadRequestException(
          'Appointment is not linked to a treatment entitlement',
        );
      }
      // Spec §"Cannot consume cancelled appointment"
      if (
        appt.status === AppointmentStatus.CANCELLED ||
        appt.status === AppointmentStatus.NO_SHOW
      ) {
        throw new BadRequestException(
          `Cannot consume entitlement on a ${appt.status} appointment`,
        );
      }

      // Idempotent fast-path: already consumed by an earlier call (e.g.
      // the auto-consume on /complete already fired). Return the
      // current entitlement view without changing anything.
      if (appt.entitlementConsumedAt) {
        const current = await tx.treatmentEntitlement.findUniqueOrThrow({
          where: { id: appt.entitlementId },
          include: ENTITLEMENT_INCLUDE,
        });
        return toView(current);
      }

      const updated = await this.tryConsumeAppointmentWith(
        tx,
        appt.entitlementId,
        appointmentId,
      );

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: appt.branchId,
        entityType: 'TreatmentEntitlement',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'consumedSessions',
          appointmentId,
          from: updated.consumedSessions - 1,
          to: updated.consumedSessions,
          totalSessions: updated.totalSessions,
          ...(note ? { note } : {}),
        },
      });

      return toView(updated);
    });
  }

  async expire(
    user: AuthenticatedUser,
    id: string,
    reason?: string,
  ): Promise<EntitlementView> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.treatmentEntitlement.findUnique({
        where: { id },
        select: { id: true, customerId: true, expiredAt: true },
      });
      if (!row) throw new NotFoundException('Entitlement not found');

      const customer = await tx.customer.findUnique({
        where: { id: row.customerId },
        select: { currentBranchId: true },
      });
      assertBranchAccess(user, customer?.currentBranchId ?? null);

      if (row.expiredAt) {
        // Idempotent: already expired. Return the current view.
        const current = await tx.treatmentEntitlement.findUniqueOrThrow({
          where: { id },
          include: ENTITLEMENT_INCLUDE,
        });
        return toView(current);
      }

      const updated = await tx.treatmentEntitlement.update({
        where: { id },
        data: { expiredAt: new Date() },
        include: ENTITLEMENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: customer?.currentBranchId ?? null,
        entityType: 'TreatmentEntitlement',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'expiredAt',
          to: updated.expiredAt?.toISOString(),
          ...(reason ? { reason } : {}),
        },
      });

      return toView(updated);
    });
  }

  // ────────────────────── Cross-service helpers ──────────────────────

  /**
   * Mint entitlements for every line of a SalesOrder whose service is a
   * program. Called from `PaymentsService.create` exactly once per order
   * — at the first transition into status=PAID.
   *
   * Idempotent by way of the `salesOrderItemId @unique` constraint:
   * re-running this for the same order is a no-op for already-minted
   * lines (we skip rather than throw on conflict).
   *
   * MUST be invoked inside the caller's `$transaction` so the
   * entitlement creation rolls back with the payment if anything else
   * in the surrounding write fails.
   */
  async createForPaidOrderWith(
    tx: Prisma.TransactionClient,
    salesOrderId: string,
    actorUserId: string,
  ): Promise<TreatmentEntitlement[]> {
    const order = await tx.salesOrder.findUnique({
      where: { id: salesOrderId },
      select: {
        id: true,
        branchId: true,
        customerId: true,
        items: {
          select: {
            id: true,
            serviceId: true,
            quantity: true,
            service: {
              select: {
                id: true,
                code: true,
                name: true,
                isProgram: true,
                defaultSessions: true,
              },
            },
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException(
        'Sales order not found for entitlement creation',
      );
    }

    const created: TreatmentEntitlement[] = [];
    for (const item of order.items) {
      if (!item.service.isProgram) continue;

      const sessionsPerUnit = item.service.defaultSessions;
      if (!sessionsPerUnit || sessionsPerUnit <= 0) {
        // Misconfiguration — a program service without a session count.
        // Better to fail loudly so ops fix the service rather than
        // silently mint a zero-session entitlement that booking would
        // immediately reject.
        throw new BadRequestException(
          `Service ${item.service.code} is flagged isProgram but has no defaultSessions`,
        );
      }
      const totalSessions = sessionsPerUnit * Math.max(1, item.quantity);

      // Skip if entitlement already exists (idempotency). The unique
      // constraint guarantees at most one per item; this branch makes
      // the operation safe to call repeatedly.
      const existing = await tx.treatmentEntitlement.findUnique({
        where: { salesOrderItemId: item.id },
        select: { id: true },
      });
      if (existing) continue;

      const ent = await tx.treatmentEntitlement.create({
        data: {
          customerId: order.customerId,
          salesOrderItemId: item.id,
          serviceId: item.serviceId,
          totalSessions,
          consumedSessions: 0,
        },
      });
      created.push(ent);

      await this.audit.recordWith(tx, {
        actorUserId,
        branchId: order.branchId,
        entityType: 'TreatmentEntitlement',
        entityId: ent.id,
        action: AuditAction.CREATE,
        payload: {
          salesOrderId,
          salesOrderItemId: item.id,
          serviceId: item.serviceId,
          serviceCode: item.service.code,
          totalSessions,
          quantity: item.quantity,
          sessionsPerUnit,
        },
      });
    }

    if (created.length > 0) {
      this.logger.log(
        `Minted ${created.length} entitlement(s) for SalesOrder ${salesOrderId}`,
      );
    }
    return created;
  }

  /**
   * Validate an entitlement is usable for a booking against
   * `(customerId, serviceId)`. Throws on any guard failure. Pure read,
   * safe to call inside any transaction or outside one.
   */
  async assertBookable(
    client: Prisma.TransactionClient | PrismaService,
    entitlementId: string,
    customerId: string,
    serviceId: string,
  ): Promise<void> {
    const ent = await client.treatmentEntitlement.findUnique({
      where: { id: entitlementId },
      select: {
        id: true,
        customerId: true,
        serviceId: true,
        totalSessions: true,
        consumedSessions: true,
        expiredAt: true,
      },
    });
    if (!ent) throw new NotFoundException('Entitlement not found');
    if (ent.customerId !== customerId) {
      throw new ForbiddenException(
        'Entitlement does not belong to this customer',
      );
    }
    if (ent.serviceId !== serviceId) {
      throw new BadRequestException(
        'Entitlement is for a different service than the requested booking',
      );
    }
    if (ent.expiredAt && ent.expiredAt.getTime() <= Date.now()) {
      throw new BadRequestException('Entitlement has expired');
    }
    if (ent.consumedSessions >= ent.totalSessions) {
      throw new ConflictException(
        'Entitlement has no remaining sessions to book',
      );
    }
  }

  /**
   * Atomic single-session drawdown.
   *
   * Uses a Postgres-side guard (`UPDATE ... WHERE consumed_sessions <
   * total_sessions AND not expired`) so two concurrent consumes cannot
   * over-spend a 7/7 entitlement: the loser sees `count = 0` and we
   * surface a Conflict exception.
   *
   * Also stamps `entitlementConsumedAt` on the appointment in the same
   * transaction so subsequent calls (auto-consume on /complete + manual
   * /consume) become no-ops.
   */
  async tryConsumeAppointmentWith(
    tx: Prisma.TransactionClient,
    entitlementId: string,
    appointmentId: string,
  ): Promise<EntitlementWithService> {
    // Guard against double-consume on the SAME appointment first; this
    // is cheap and rules out the common race (operator double-clicks
    // /consume). Concurrent racing across different appointments is
    // handled by the SQL guard below.
    const apptStamp = await tx.appointment.updateMany({
      where: { id: appointmentId, entitlementConsumedAt: null },
      data: { entitlementConsumedAt: new Date() },
    });
    if (apptStamp.count === 0) {
      throw new ConflictException(
        'This appointment has already consumed its entitlement',
      );
    }

    // Second guard: the entitlement itself has remaining sessions and
    // is not expired. Atomic via a single UPDATE statement; loser of a
    // race gets `numUpdatedRows = 0` and we throw. Prisma maps Int +
    // DateTime fields to quoted-camelCase columns (`"consumedSessions"`,
    // `"totalSessions"`, `"expiredAt"`, `"updatedAt"`) so we quote them
    // here to match the generated DDL.
    const result = await tx.$executeRaw`
      UPDATE treatment_entitlements
      SET "consumedSessions" = "consumedSessions" + 1,
          "updatedAt" = NOW()
      WHERE id = ${entitlementId}
        AND "consumedSessions" < "totalSessions"
        AND ("expiredAt" IS NULL OR "expiredAt" > NOW())
    `;
    // Prisma returns the number of affected rows for $executeRaw.
    if (Number(result) === 0) {
      // Roll the whole transaction back — including the appointment
      // stamp we just wrote — by throwing.
      throw new ConflictException(
        'Entitlement has no remaining sessions or has expired',
      );
    }

    const updated = await tx.treatmentEntitlement.findUniqueOrThrow({
      where: { id: entitlementId },
      include: ENTITLEMENT_INCLUDE,
    });
    return updated;
  }

  // ────────────────────── private ──────────────────────

  private async loadOrThrow(id: string): Promise<EntitlementWithService> {
    const row = await this.prisma.treatmentEntitlement.findUnique({
      where: { id },
      include: ENTITLEMENT_INCLUDE,
    });
    if (!row) throw new NotFoundException('Entitlement not found');
    return row;
  }
}

// Module-private projection. Kept outside the class so callers (and
// tests) can import it without instantiating the service.
export function toView(row: EntitlementWithService): EntitlementView {
  const remaining = Math.max(0, row.totalSessions - row.consumedSessions);
  return {
    id: row.id,
    customerId: row.customerId,
    serviceId: row.serviceId,
    serviceName: row.service.name,
    serviceCode: row.service.code,
    salesOrderItemId: row.salesOrderItemId,
    salesOrderId: row.salesOrderItem.salesOrder.id,
    salesOrderNo: row.salesOrderItem.salesOrder.orderNo,
    salesOrderStatus: row.salesOrderItem.salesOrder.status,
    totalSessions: row.totalSessions,
    consumedSessions: row.consumedSessions,
    remainingSessions: remaining,
    activatedAt: row.activatedAt,
    expiredAt: row.expiredAt,
    isExpired: row.expiredAt ? row.expiredAt.getTime() <= Date.now() : false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Re-exported for use in unit tests that want to validate the same
// guards the live SQL guard enforces.
export interface EntitlementGuardInput {
  customerId: string;
  serviceId: string;
  totalSessions: number;
  consumedSessions: number;
  expiredAt: Date | null;
}

export type GuardError =
  | 'WRONG_CUSTOMER'
  | 'WRONG_SERVICE'
  | 'EXPIRED'
  | 'EXHAUSTED';

/**
 * Pure-function mirror of `assertBookable`'s rejection rules. Used by
 * unit tests so we can exercise the guards without spinning up a DB.
 */
export function checkEntitlementGuards(
  ent: EntitlementGuardInput,
  expectedCustomerId: string,
  expectedServiceId: string,
  now: Date = new Date(),
): GuardError | null {
  if (ent.customerId !== expectedCustomerId) return 'WRONG_CUSTOMER';
  if (ent.serviceId !== expectedServiceId) return 'WRONG_SERVICE';
  if (ent.expiredAt && ent.expiredAt.getTime() <= now.getTime())
    return 'EXPIRED';
  if (ent.consumedSessions >= ent.totalSessions) return 'EXHAUSTED';
  return null;
}
