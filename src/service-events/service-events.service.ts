import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentStatus,
  AuditAction,
  ConsumptionStrategy,
  CustomerServiceEvent,
  Prisma,
  ServiceEventStatus,
  StockLotStatus,
  StockMovementType,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import {
  assertBranchAccess,
  isUnrestricted,
} from '../common/authz/branch-scope';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteServiceEventDto } from './dto/complete-service-event.dto';
import { ConsumeStockDto } from './dto/consume-stock.dto';
import { CreateServiceEventDto } from './dto/create-service-event.dto';
import { ServiceEventQueryDto } from './dto/service-event-query.dto';

const EVENT_INCLUDE = {
  customer: { select: { id: true, code: true, fullName: true, phone: true } },
  branch: { select: { id: true, code: true, name: true } },
  service: { select: { id: true, code: true, name: true } },
  doctorUser: { select: { id: true, fullName: true, email: true } },
  employeeUser: { select: { id: true, fullName: true, email: true } },
  appointment: {
    select: { id: true, appointmentNo: true, status: true, scheduledAt: true },
  },
  salesOrder: { select: { id: true, orderNo: true, status: true } },
  stockUsages: {
    orderBy: { createdAt: 'asc' },
    include: {
      stockItem: { select: { id: true, sku: true, name: true } },
      stockLot: { select: { id: true, lotCode: true, expiresAt: true } },
    },
  },
} satisfies Prisma.CustomerServiceEventInclude;

type ServiceEventWithRelations = Prisma.CustomerServiceEventGetPayload<{
  include: typeof EVENT_INCLUDE;
}>;

@Injectable()
export class ServiceEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(
    user: AuthenticatedUser,
    dto: CreateServiceEventDto,
  ): Promise<ServiceEventWithRelations> {
    // Spec accepts both flows: pre-booked (appointmentId provided) and
    // walk-in (appointmentId omitted — branchId/customerId/serviceId come
    // straight from the request). We resolve a single canonical {branchId,
    // customerId, serviceId, salesOrderId, appointmentId?} tuple here and
    // run all downstream guards against it.
    let resolvedBranchId = dto.branchId;
    let resolvedCustomerId = dto.customerId;
    let resolvedServiceId = dto.serviceId;
    let resolvedSalesOrderId: string | null = dto.salesOrderId ?? null;
    let resolvedAppointmentId: string | null = null;

    if (dto.appointmentId) {
      const appointment = await this.prisma.appointment.findUnique({
        where: { id: dto.appointmentId },
        select: {
          id: true,
          branchId: true,
          salesOrderId: true,
          customerId: true,
          serviceId: true,
          status: true,
        },
      });
      if (!appointment) throw new NotFoundException('Appointment not found');
      assertBranchAccess(user, appointment.branchId);

      if (appointment.status !== AppointmentStatus.CHECKED_IN) {
        throw new BadRequestException(
          `Appointment must be CHECKED_IN to record a service event (current: ${appointment.status})`,
        );
      }
      if (appointment.customerId !== dto.customerId) {
        throw new BadRequestException(
          'Customer does not match the appointment customer',
        );
      }
      if (appointment.serviceId !== dto.serviceId) {
        throw new BadRequestException(
          'Service does not match the appointment service',
        );
      }
      if (appointment.branchId !== dto.branchId) {
        throw new BadRequestException(
          'branchId does not match the appointment branch',
        );
      }
      if (
        dto.salesOrderId &&
        dto.salesOrderId !== appointment.salesOrderId
      ) {
        throw new BadRequestException(
          'salesOrderId does not match the appointment sales order',
        );
      }

      resolvedAppointmentId = appointment.id;
      resolvedSalesOrderId = appointment.salesOrderId;
    } else {
      // Walk-in path: validate the requested branch is accessible to this
      // user and that the customer/service/sales-order references resolve.
      assertBranchAccess(user, dto.branchId);
      const [customer, service, salesOrder] = await Promise.all([
        this.prisma.customer.findUnique({
          where: { id: dto.customerId },
          select: { id: true, deletedAt: true },
        }),
        this.prisma.service.findUnique({
          where: { id: dto.serviceId },
          select: { id: true, isActive: true },
        }),
        dto.salesOrderId
          ? this.prisma.salesOrder.findUnique({
              where: { id: dto.salesOrderId },
              select: { id: true, branchId: true, customerId: true },
            })
          : Promise.resolve(null),
      ]);
      if (!customer || customer.deletedAt) {
        throw new BadRequestException('Customer does not exist');
      }
      if (!service) throw new BadRequestException('Service does not exist');
      if (!service.isActive) {
        throw new BadRequestException('Service is not active');
      }
      if (dto.salesOrderId) {
        if (!salesOrder) {
          throw new BadRequestException('Sales order does not exist');
        }
        if (salesOrder.branchId !== dto.branchId) {
          throw new BadRequestException(
            'salesOrder.branchId does not match request branchId',
          );
        }
        if (salesOrder.customerId !== dto.customerId) {
          throw new BadRequestException(
            'salesOrder.customerId does not match request customerId',
          );
        }
      }
    }

    if (dto.doctorUserId) await this.assertUserActive(dto.doctorUserId, 'Doctor');
    if (dto.employeeUserId)
      await this.assertUserActive(dto.employeeUserId, 'Employee');

    const performedAt = dto.performedAt ? new Date(dto.performedAt) : new Date();

    return this.prisma.$transaction(async (tx) => {
      const event = await tx.customerServiceEvent.create({
        data: {
          customerId: resolvedCustomerId,
          branchId: resolvedBranchId,
          serviceId: resolvedServiceId,
          doctorUserId: dto.doctorUserId ?? null,
          employeeUserId: dto.employeeUserId ?? null,
          salesOrderId: resolvedSalesOrderId,
          appointmentId: resolvedAppointmentId,
          status: ServiceEventStatus.IN_PROGRESS,
          performedAt,
          notes: dto.notes,
        },
        include: EVENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: event.branchId,
        entityType: 'CustomerServiceEvent',
        entityId: event.id,
        action: AuditAction.CREATE,
        payload: {
          customerId: event.customerId,
          serviceId: event.serviceId,
          appointmentId: event.appointmentId,
          salesOrderId: event.salesOrderId,
          doctorUserId: event.doctorUserId,
          employeeUserId: event.employeeUserId,
          performedAt: event.performedAt.toISOString(),
          walkIn: resolvedAppointmentId === null,
        },
      });

      return event;
    });
  }

  // ───────────────────────── list ─────────────────────────
  async findAll(
    user: AuthenticatedUser,
    query: ServiceEventQueryDto,
  ): Promise<PaginatedResult<ServiceEventWithRelations>> {
    if (query.branchId) assertBranchAccess(user, query.branchId);

    const where: Prisma.CustomerServiceEventWhereInput = {
      ...this.branchScopeFilter(user, query.branchId),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
      ...(query.doctorUserId ? { doctorUserId: query.doctorUserId } : {}),
      ...(query.employeeUserId
        ? { employeeUserId: query.employeeUserId }
        : {}),
      ...(query.appointmentId ? { appointmentId: query.appointmentId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.dateRangeFilter(query.from, query.to),
    };

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.customerServiceEvent.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { performedAt: 'desc' },
        include: EVENT_INCLUDE,
      }),
      this.prisma.customerServiceEvent.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(
    user: AuthenticatedUser,
    id: string,
  ): Promise<ServiceEventWithRelations> {
    const event = await this.prisma.customerServiceEvent.findUnique({
      where: { id },
      include: EVENT_INCLUDE,
    });
    if (!event) throw new NotFoundException('Service event not found');
    assertBranchAccess(user, event.branchId);
    return event;
  }

  // ───────────────────────── customer history ─────────────────────────
  async findByCustomer(
    user: AuthenticatedUser,
    customerId: string,
    query: ServiceEventQueryDto,
  ): Promise<PaginatedResult<ServiceEventWithRelations>> {
    return this.findAll(user, { ...query, customerId });
  }

  // ───────────────────────── consume stock ─────────────────────────
  async consumeStock(
    user: AuthenticatedUser,
    eventId: string,
    dto: ConsumeStockDto,
  ): Promise<ServiceEventWithRelations> {
    const event = await this.findOne(user, eventId);
    if (event.status !== ServiceEventStatus.IN_PROGRESS) {
      throw new BadRequestException(
        `Stock can only be consumed while the event is IN_PROGRESS (current: ${event.status})`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Row-lock the lot for the duration of the tx so two concurrent
      // consumes can't both read the same quantityOnHand and double-spend.
      await tx.$executeRaw`SELECT id FROM stock_lots WHERE id = ${dto.stockLotId} FOR UPDATE`;

      const lot = await tx.stockLot.findUnique({
        where: { id: dto.stockLotId },
        select: {
          id: true,
          stockItemId: true,
          warehouseId: true,
          status: true,
          quantityOnHand: true,
          expiresAt: true,
          stockItem: {
            select: { consumptionStrategy: true },
          },
        },
      });
      if (!lot) throw new NotFoundException('Stock lot not found');
      if (lot.status !== StockLotStatus.ACTIVE) {
        throw new BadRequestException(
          `Stock lot is ${lot.status}, cannot consume`,
        );
      }
      if (lot.expiresAt && lot.expiresAt.getTime() < Date.now()) {
        throw new BadRequestException('Stock lot has expired');
      }
      // PARTIAL_REQUIRED items must flow through OpenedContainer — direct lot
      // consumption is forbidden for them so partial-vial accounting stays
      // intact. Callers may still attribute usage to a container by passing
      // `openedContainerId`, but that goes through a separate code path.
      if (
        lot.stockItem.consumptionStrategy === ConsumptionStrategy.PARTIAL_REQUIRED &&
        !dto.openedContainerId
      ) {
        throw new BadRequestException(
          'Stock item requires partial consumption via an OpenedContainer; open a container first and consume against it',
        );
      }
      // WHOLE_ONLY items (boxed retail/clinical SKUs) can only be consumed
      // in integer quantities. Reject fractional quantities loudly so
      // someone doesn't accidentally write off 0.5 of a sealed box.
      if (
        lot.stockItem.consumptionStrategy === ConsumptionStrategy.WHOLE_ONLY &&
        !Number.isInteger(dto.quantity)
      ) {
        throw new BadRequestException(
          `Stock item is WHOLE_ONLY; quantity must be an integer (got ${dto.quantity})`,
        );
      }
      const onHand = decToNum(lot.quantityOnHand);
      if (dto.quantity > onHand) {
        throw new BadRequestException(
          `Insufficient stock (requested ${dto.quantity}, on hand ${onHand})`,
        );
      }
      const newOnHand = round6(onHand - dto.quantity);
      const exhausted = newOnHand === 0;

      await tx.stockLot.update({
        where: { id: lot.id },
        data: {
          quantityOnHand: newOnHand,
          ...(exhausted ? { status: StockLotStatus.EXHAUSTED } : {}),
        },
      });

      await tx.stockMovement.create({
        data: {
          stockLotId: lot.id,
          warehouseId: lot.warehouseId,
          createdByUserId: user.id,
          type: StockMovementType.CLINICAL_USAGE,
          quantityDelta: -dto.quantity,
          referenceType: 'CUSTOMER_SERVICE_EVENT',
          referenceId: event.id,
          note: dto.note,
        },
      });

      await tx.serviceStockUsage.create({
        data: {
          customerServiceEventId: event.id,
          serviceId: event.serviceId,
          stockItemId: lot.stockItemId,
          stockLotId: lot.id,
          openedContainerId: dto.openedContainerId ?? null,
          quantityPrimaryUsed: dto.quantity,
        },
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: event.branchId,
        entityType: 'CustomerServiceEvent',
        entityId: event.id,
        action: AuditAction.UPDATE,
        payload: {
          stockConsumed: {
            stockLotId: lot.id,
            stockItemId: lot.stockItemId,
            quantity: dto.quantity,
            lotOnHandAfter: newOnHand,
            lotExhausted: exhausted,
            openedContainerId: dto.openedContainerId ?? null,
          },
        },
      });

      return tx.customerServiceEvent.findUniqueOrThrow({
        where: { id: event.id },
        include: EVENT_INCLUDE,
      });
    });
  }

  // ───────────────────────── complete ─────────────────────────
  async complete(
    user: AuthenticatedUser,
    id: string,
    dto: CompleteServiceEventDto,
  ): Promise<ServiceEventWithRelations> {
    const event = await this.findOne(user, id);
    if (event.status === ServiceEventStatus.COMPLETED) {
      throw new BadRequestException('Service event is already COMPLETED');
    }
    if (event.status === ServiceEventStatus.VOIDED) {
      throw new BadRequestException('Cannot complete a VOIDED service event');
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const completed = await tx.customerServiceEvent.update({
        where: { id: event.id },
        data: {
          status: ServiceEventStatus.COMPLETED,
          completedAt: now,
          ...(dto.note ? { notes: appendNote(event.notes, dto.note) } : {}),
        },
        include: EVENT_INCLUDE,
      });

      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: completed.branchId,
        entityType: 'CustomerServiceEvent',
        entityId: completed.id,
        action: AuditAction.UPDATE,
        payload: {
          field: 'status',
          from: event.status,
          to: ServiceEventStatus.COMPLETED,
          completedAt: now.toISOString(),
        },
      });

      // Auto-complete the appointment when every event linked to it is done.
      if (completed.appointmentId) {
        await this.maybeAutoCompleteAppointment(
          tx,
          user,
          completed.appointmentId,
          now,
        );
      }

      return completed;
    });
  }

  // ───────────────────────── helpers ─────────────────────────
  private async maybeAutoCompleteAppointment(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    appointmentId: string,
    now: Date,
  ): Promise<void> {
    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      select: { id: true, status: true, branchId: true },
    });
    if (!appointment || appointment.status !== AppointmentStatus.CHECKED_IN) {
      return;
    }

    const pending = await tx.customerServiceEvent.count({
      where: {
        appointmentId,
        status: { not: ServiceEventStatus.COMPLETED },
      },
    });
    if (pending > 0) return;

    await tx.appointment.update({
      where: { id: appointmentId },
      data: { status: AppointmentStatus.COMPLETED, completedAt: now },
    });
    await this.audit.recordWith(tx, {
      actorUserId: user.id,
      branchId: appointment.branchId,
      entityType: 'Appointment',
      entityId: appointmentId,
      action: AuditAction.UPDATE,
      payload: {
        field: 'status',
        from: AppointmentStatus.CHECKED_IN,
        to: AppointmentStatus.COMPLETED,
        autoCompletedBy: 'service-events',
      },
    });
  }

  private async assertUserActive(
    userId: string,
    label: string,
  ): Promise<void> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!u) throw new NotFoundException(`${label} user not found`);
    if (u.status !== 'ACTIVE') {
      throw new BadRequestException(`${label} user is not active`);
    }
  }

  private branchScopeFilter(
    user: AuthenticatedUser,
    requested: string | undefined,
  ): Prisma.CustomerServiceEventWhereInput {
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
  ): Prisma.CustomerServiceEventWhereInput {
    if (!from && !to) return {};
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(from);
    if (to) range.lte = new Date(to);
    return { performedAt: range };
  }
}

// ─────────────────────── module-private utils ───────────────────────

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const decToNum = (
  v: Prisma.Decimal | number | null | undefined,
): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};

function appendNote(existing: string | null, addition: string): string {
  if (!existing) return addition;
  return `${existing}\n${addition}`;
}

// Suppress unused-symbol warning for the type kept for consumers.
export type { CustomerServiceEvent };
