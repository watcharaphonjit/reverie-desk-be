import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { WarehouseQueryDto } from './dto/warehouse-query.dto';

const WAREHOUSE_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
} satisfies Prisma.WarehouseInclude;

type WarehouseWithRelations = Prisma.WarehouseGetPayload<{
  include: typeof WAREHOUSE_INCLUDE;
}>;

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    query: WarehouseQueryDto,
  ): Promise<PaginatedResult<WarehouseWithRelations>> {
    const { page = 1, limit = 20, branchId, type, isActive, search } = query;
    const where: Prisma.WarehouseWhereInput = {
      ...(branchId ? { branchId } : {}),
      ...(type ? { type } : {}),
      ...(typeof isActive === 'boolean' ? { isActive } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.warehouse.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        include: WAREHOUSE_INCLUDE,
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<WarehouseWithRelations> {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id },
      include: WAREHOUSE_INCLUDE,
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return warehouse;
  }
}
