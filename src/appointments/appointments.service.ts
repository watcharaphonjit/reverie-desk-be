import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Appointment,
  AppointmentStatus,
  AuditAction,
  NotificationType,
  Prisma,
  SalesOrderStatus,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  assertBranchAccess,
  isUnrestricted,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { TreatmentEntitlementsService } from '../treatment-entitlements/treatment-entitlements.service';
import { AppointmentQueryDto } from './dto/appointment-query.dto';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

const APPOINTMENT_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  customer: { select: { id: true, code: true, fullName: true, phone: true } },
  service: { select: { id: true, code: true, name: true } },
  doctor: { select: { id: true, fullName: true, email: true } },
  createdBy: { select: { id: true, fullName: true, email: true } },
  salesOrder: {
    select: { id: true, orderNo: true, status: true, branchId: true },
  },
  // Spec §"Get Appointment Detail" wants service events on the detail
  // payload so the front-end can show what was actually performed during
  // the visit alongside the appointment metadata.
  serviceEvents: {
    orderBy: { performedAt: 'asc' },
    select: {
      id: true,
      status: true,
      performedAt: true,
      completedAt: true,
      serviceId: true,
      doctorUserId: true,
      employeeUserId: true,
    },
  },
} satisfies Prisma.AppointmentInclude;

type AppointmentWithRelations = Prisma.AppointmentGetPayload<{
  include: typeof APPOINTMENT_INCLUDE;
}>;

const ORDER_BLOCKED_FOR_BOOKING: ReadonlyArray<SalesOrderStatus> = [
  SalesOrderStatus.CANCELLED,
  SalesOrderStatus.REFUNDED,
];

/**
 * Allowed status transitions per spec §"Appointment State Validation":
 *   BOOKED      → CHECKED_IN, CANCELLED
 *   CHECKED_IN  → COMPLETED            (cancel from CHECKED_IN is forbidden;
 *                                        the visit started, so unwind via
 *                                        complete-then-refund instead)
 *   COMPLETED, CANCELLED, NO_SHOW are terminal.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<AppointmentStatus, ReadonlyArray<AppointmentStatus>>
> = {
  BOOKED: [AppointmentStatus.CHECKED_IN, AppointmentStatus.CANCELLED],
  CHECKED_IN: [AppointmentStatus.COMPLETED],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly entitlements: TreatmentEntitlementsService,
  ) {}

  // ───────────────────────── create / book ─────────────────────────
  async create(
    user: AuthenticatedUser,
    dto: CreateAppointmentDto,
  ): Promise<AppointmentWithRelations> {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: dto.salesOrderId },
      select: {
        id: true,
        branchId: true,
        customerId: true,
        status: true,
        items: { select: { serviceId: true } },
      },
    });
    if (!order) throw new NotFoundException('Sales order not found');
    assertBranchAccess(user, order.branchId);

    if (ORDER_BLOCKED_FOR_BOOKING.includes(order.status)) {
      throw new BadRequestException(
        `Cannot book against a ${order.status} sales order`,
      );
    }
    if (order.customerId !== dto.customerId) {
      throw new BadRequestException(
        'Customer does not match the sales order customer',
      );
    }
    const orderServiceIds = new Set(order.items.map((i) => i.serviceId));
    if (!orderServiceIds.has(dto.serviceId)) {
      throw new BadRequestException(
        'Service is not part of the referenced sales order',
      );
    }
    if (dto.doctorUserId) await this.assertDoctorActive(dto.doctorUserId);

    const scheduledAt = new Date(dto.scheduledAt);

    const appointment = await this.prisma.$transaction(async (tx) => {
      // Spec §"Appointment Booking validation": entitlement must belong
      // to the same customer + service and have remaining (non-expired)
      // sessions. We validate inside the tx so a concurrent expire/
      // consume between the read and the appointment write is observed.
      if (dto.entitlementId) {
        await this.entitlements.assertBookable(
          tx,
          dto.entitlementId,
          order.customerId,
          dto.serviceId,
        );
      }

      const appointmentNo = await generateAppointmentNo(tx, scheduledAt);
      const created = await tx.appointment.create({
        data: {
          appointmentNo,
          branchId: order.branchId,
          salesOrderId: order.id,
          customerId: order.customerId,
          serviceId: dto.serviceId,
          doctorUserId: dto.doctorUserId ?? null,
          createdByUserId: user.id,
          status: AppointmentStatus.BOOKED,
          scheduledAt,
          notes: dto.notes,
          ...(dto.entitlementId
            ? { entitlementId: dto.entitlementId }
            : {}),
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: created.branchId,
        entityType: 'Appointment',
        entityId: created.id,
        action: AuditAction.CREATE,
        payload: {
          appointmentNo: created.appointmentNo,
          salesOrderId: created.salesOrderId,
          customerId: created.customerId,
          serviceId: created.serviceId,
          doctorUserId: created.doctorUserId,
          scheduledAt: created.scheduledAt.toISOString(),
          ...(dto.entitlementId
            ? { entitlementId: dto.entitlementId }
            : {}),
        },
      });

      return created;
    });

    // Post-commit notification: alert the assigned doctor that they
    // have a new booking. Idempotent via dedupeKey so re-creating after
    // a transient retry is a no-op.
    if (appointment.doctorUserId) {
      await this.notifications.notify({
        userId: appointment.doctorUserId,
        branchId: appointment.branchId,
        title: `New appointment: ${appointment.appointmentNo}`,
        message: `You have a new booking for ${appointment.customer.fullName} on ${appointment.scheduledAt.toISOString()}.`,
        type: NotificationType.APPOINTMENT_REMINDER,
        metadata: {
          appointmentId: appointment.id,
          scheduledAt: appointment.scheduledAt.toISOString(),
        },
        dedupeKey: `APPOINTMENT_CREATE|${appointment.id}|${appointment.doctorUserId}`,
      });
    }
    return appointment;
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(
    user: AuthenticatedUser,
    query: AppointmentQueryDto,
  ): Promise<PaginatedResult<AppointmentWithRelations>> {
    if (query.branchId) assertBranchAccess(user, query.branchId);

    const where: Prisma.AppointmentWhereInput = {
      ...this.branchScopeFilter(user, query.branchId),
      ...(query.doctorUserId ? { doctorUserId: query.doctorUserId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.dateRangeFilter(query.from, query.to),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.appointment.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { scheduledAt: 'asc' },
        include: APPOINTMENT_INCLUDE,
      }),
      this.prisma.appointment.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<AppointmentWithRelations> {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: APPOINTMENT_INCLUDE,
    });
    if (!appointment) throw new NotFoundException('Appointment not found');
    assertBranchAccess(user, appointment.branchId);
    return appointment;
  }

  // ───────────────────────── transitions ─────────────────────────
  checkIn(
    user: AuthenticatedUser,
    id: string,
    note?: string,
  ): Promise<AppointmentWithRelations> {
    return this.transition(user, id, AppointmentStatus.CHECKED_IN, {
      stamp: 'checkedInAt',
      note,
    });
  }

  async complete(
    user: AuthenticatedUser,
    id: string,
    note?: string,
  ): Promise<AppointmentWithRelations> {
    // Spec §"Complete Appointment": "service event must exist". The visit is
    // not legitimately completable until at least one service event has been
    // recorded — otherwise we'd lose the clinical-execution audit trail.
    const eventCount = await this.prisma.customerServiceEvent.count({
      where: { appointmentId: id },
    });
    if (eventCount === 0) {
      throw new BadRequestException(
        'Cannot complete appointment without a recorded service event',
      );
    }
    return this.transition(user, id, AppointmentStatus.COMPLETED, {
      stamp: 'completedAt',
      note,
      consumeEntitlement: true,
    });
  }

  cancel(
    user: AuthenticatedUser,
    id: string,
    reason?: string,
  ): Promise<AppointmentWithRelations> {
    return this.transition(user, id, AppointmentStatus.CANCELLED, {
      reason,
    });
  }

  // ───────────────────────── reschedule ─────────────────────────
  async reschedule(
    user: AuthenticatedUser,
    id: string,
    dto: RescheduleAppointmentDto,
  ): Promise<AppointmentWithRelations> {
    const existing = await this.findOne(user, id);
    if (existing.status !== AppointmentStatus.BOOKED) {
      throw new BadRequestException(
        `Only BOOKED appointments can be rescheduled (current: ${existing.status})`,
      );
    }
    if (dto.doctorUserId) await this.assertDoctorActive(dto.doctorUserId);

    const newScheduledAt = new Date(dto.scheduledAt);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.appointment.update({
        where: { id },
        data: {
          scheduledAt: newScheduledAt,
          ...(dto.doctorUserId !== undefined
            ? { doctorUserId: dto.doctorUserId }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'Appointment',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'scheduledAt',
          from: existing.scheduledAt.toISOString(),
          to: updated.scheduledAt.toISOString(),
          ...(dto.doctorUserId !== undefined
            ? {
                doctorUserId: {
                  from: existing.doctorUserId,
                  to: updated.doctorUserId,
                },
              }
            : {}),
        },
      });

      return updated;
    });
  }

  // ───────────────────────── helpers ─────────────────────────
  private async transition(
    user: AuthenticatedUser,
    id: string,
    next: AppointmentStatus,
    extra: {
      stamp?: 'checkedInAt' | 'completedAt';
      note?: string;
      reason?: string;
      /**
       * If true and the appointment carries an `entitlementId`, draw
       * one session from the entitlement atomically as part of this
       * transition. Idempotent via `Appointment.entitlementConsumedAt`
       * — calling /complete after an explicit /consume (or vice versa)
       * is a safe no-op.
       */
      consumeEntitlement?: boolean;
    },
  ): Promise<AppointmentWithRelations> {
    const existing = await this.findOne(user, id);
    if (!ALLOWED_TRANSITIONS[existing.status].includes(next)) {
      throw new BadRequestException(
        `Cannot transition appointment from ${existing.status} to ${next}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const updated = await tx.appointment.update({
        where: { id },
        data: {
          status: next,
          ...(extra.stamp ? { [extra.stamp]: now } : {}),
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: updated.branchId,
        entityType: 'Appointment',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'status',
          from: existing.status,
          to: next,
          ...(extra.note ? { note: extra.note } : {}),
          ...(extra.reason ? { reason: extra.reason } : {}),
        },
      });

      // Auto-consume on COMPLETED if an entitlement is linked and this
      // appointment hasn't already drawn down its session. The helper
      // throws on exhausted/expired entitlements, which (correctly)
      // rolls the whole transition back so an over-consume never
      // commits.
      if (
        extra.consumeEntitlement &&
        updated.entitlementId &&
        !updated.entitlementConsumedAt
      ) {
        const ent = await this.entitlements.tryConsumeAppointmentWith(
          tx,
          updated.entitlementId,
          updated.id,
        );
        await this.audit.recordWith(tx, {
          actorUserId: user.id,
          branchId: updated.branchId,
          entityType: 'TreatmentEntitlement',
          entityId: ent.id,
          action: AuditAction.UPDATE,
          payload: {
            field: 'consumedSessions',
            appointmentId: updated.id,
            from: ent.consumedSessions - 1,
            to: ent.consumedSessions,
            totalSessions: ent.totalSessions,
            trigger: 'appointment.complete',
          },
        });
      }

      return updated;
    });
  }

  private async assertDoctorActive(userId: string): Promise<void> {
    const doctor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!doctor) throw new NotFoundException('Doctor user not found');
    if (doctor.status !== 'ACTIVE') {
      throw new BadRequestException('Doctor user is not active');
    }
  }

  private branchScopeFilter(
    user: AuthenticatedUser,
    requested: string | undefined,
  ): Prisma.AppointmentWhereInput {
    if (requested) return { branchId: requested };
    if (isUnrestricted(user)) return {};
    if (!user.branchId) {
      throw new ForbiddenException('User has no branch assignment');
    }
    return { branchId: user.branchId };
  }

  private dateRangeFilter(
    from: string | undefined,
    to: string | undefined,
  ): Prisma.AppointmentWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { scheduledAt: range };
  }
}

// ─────────────────────── module-private utils ───────────────────────

/**
 * Concurrency-safe per-day appointment-number generator.
 * Format: `APT-YYYYMMDD-####`. The day is derived from `scheduledAt` (UTC),
 * and the advisory lock key includes the day so two different days don't
 * contend with each other.
 */
async function generateAppointmentNo(
  tx: Prisma.TransactionClient,
  scheduledAt: Date,
): Promise<string> {
  const yyyymmdd = formatYYYYMMDD(scheduledAt);
  const lockKey = `appointment-no-${yyyymmdd}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  const prefix = `APT-${yyyymmdd}-`;
  const last = await tx.appointment.findFirst({
    where: { appointmentNo: { startsWith: prefix } },
    orderBy: { appointmentNo: 'desc' },
    select: { appointmentNo: true },
  });
  const lastSeq = last
    ? parseInt(last.appointmentNo.slice(prefix.length), 10)
    : 0;
  const nextSeq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

const formatYYYYMMDD = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
