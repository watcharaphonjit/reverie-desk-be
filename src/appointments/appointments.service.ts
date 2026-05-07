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
import { PrismaService } from '../prisma/prisma.service';
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
} satisfies Prisma.AppointmentInclude;

type AppointmentWithRelations = Prisma.AppointmentGetPayload<{
  include: typeof APPOINTMENT_INCLUDE;
}>;

const ORDER_BLOCKED_FOR_BOOKING: ReadonlyArray<SalesOrderStatus> = [
  SalesOrderStatus.CANCELLED,
  SalesOrderStatus.REFUNDED,
];

/**
 * Allowed status transitions per the spec.
 * COMPLETED and CANCELLED are terminal (no outgoing edges).
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<AppointmentStatus, ReadonlyArray<AppointmentStatus>>
> = {
  BOOKED: [AppointmentStatus.CHECKED_IN, AppointmentStatus.CANCELLED],
  CHECKED_IN: [AppointmentStatus.COMPLETED, AppointmentStatus.CANCELLED],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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

    return this.prisma.$transaction(async (tx) => {
      const appointmentNo = await generateAppointmentNo(tx, scheduledAt);
      const appointment = await tx.appointment.create({
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
        },
        include: APPOINTMENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: appointment.branchId,
        entityType: 'Appointment',
        entityId: appointment.id,
        action: AuditAction.CREATE,
        payload: {
          appointmentNo: appointment.appointmentNo,
          salesOrderId: appointment.salesOrderId,
          customerId: appointment.customerId,
          serviceId: appointment.serviceId,
          doctorUserId: appointment.doctorUserId,
          scheduledAt: appointment.scheduledAt.toISOString(),
        },
      });

      return appointment;
    });
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

  complete(
    user: AuthenticatedUser,
    id: string,
    note?: string,
  ): Promise<AppointmentWithRelations> {
    return this.transition(user, id, AppointmentStatus.COMPLETED, {
      stamp: 'completedAt',
      note,
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
    extra: { stamp?: 'checkedInAt' | 'completedAt'; note?: string; reason?: string },
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
