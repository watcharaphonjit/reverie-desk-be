import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { StockMovementQueryDto } from './dto/stock-movement-query.dto';

const STOCK_MOVEMENT_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true, type: true } },
  createdByUser: { select: { id: true, fullName: true, email: true } },
  stockLot: {
    select: {
      id: true,
      lotCode: true,
      expiresAt: true,
      stockItem: {
        select: { id: true, sku: true, name: true, type: true },
      },
    },
  },
} satisfies Prisma.StockMovementInclude;

type StockMovementWithRelations = Prisma.StockMovementGetPayload<{
  include: typeof STOCK_MOVEMENT_INCLUDE;
}>;

@Injectable()
export class StockMovementsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    query: StockMovementQueryDto,
  ): Promise<PaginatedResult<StockMovementWithRelations>> {
    const { page, limit } = query;
    const where: Prisma.StockMovementWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.referenceType ? { referenceType: query.referenceType } : {}),
      ...(query.stockItemId
        ? { stockLot: { stockItemId: query.stockItemId } }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { note: { contains: query.search, mode: 'insensitive' } },
              {
                stockLot: {
                  lotCode: { contains: query.search, mode: 'insensitive' },
                },
              },
              {
                stockLot: {
                  stockItem: {
                    name: { contains: query.search, mode: 'insensitive' },
                  },
                },
              },
              {
                stockLot: {
                  stockItem: {
                    sku: { contains: query.search, mode: 'insensitive' },
                  },
                },
              },
              { referenceId: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: STOCK_MOVEMENT_INCLUDE,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<StockMovementWithRelations> {
    const movement = await this.prisma.stockMovement.findUnique({
      where: { id },
      include: STOCK_MOVEMENT_INCLUDE,
    });
    if (!movement) throw new NotFoundException('Stock movement not found');
    return movement;
  }
}
