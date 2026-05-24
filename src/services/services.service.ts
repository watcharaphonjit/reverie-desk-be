import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedResult } from '../common/dto/pagination.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ListServicesQuery } from './dto/list-services.query';

const SERVICE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  basePrice: true,
  commissionGroupCode: true,
  isProgram: true,
  defaultSessions: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ServiceSelect;

type ServiceListItem = Prisma.ServiceGetPayload<{
  select: typeof SERVICE_SELECT;
}>;

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    query: ListServicesQuery,
  ): Promise<PaginatedResult<ServiceListItem>> {
    const { page, limit } = query;
    const where: Prisma.ServiceWhereInput = {
      deletedAt: null,
      isActive: query.isActive ?? true,
      ...(query.isProgram !== undefined ? { isProgram: query.isProgram } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.service.findMany({
        where,
        select: SERVICE_SELECT,
        orderBy: [{ isProgram: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.service.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<ServiceListItem> {
    const service = await this.prisma.service.findFirst({
      where: { id, deletedAt: null },
      select: SERVICE_SELECT,
    });
    if (!service) throw new NotFoundException('Service not found');
    return service;
  }

  async findDefaultStock(serviceId: string) {
    await this.findOne(serviceId);
    return this.prisma.serviceDefaultStock.findMany({
      where: { serviceId },
      include: {
        stockItem: {
          select: {
            id: true,
            sku: true,
            name: true,
            type: true,
            primaryUnitId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}
