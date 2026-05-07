import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, Supplier } from '@prisma/client';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PaginatedResult } from '../../common/dto/pagination.dto';
import { AuditService } from '../../common/services/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { SupplierQueryDto } from './dto/supplier-query.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    user: AuthenticatedUser,
    dto: CreateSupplierDto,
  ): Promise<Supplier> {
    await this.assertCodeAvailable(dto.code);
    return this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({
        data: { code: dto.code, name: dto.name, phone: dto.phone },
      });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'Supplier',
        entityId: supplier.id,
        action: AuditAction.CREATE,
        payload: { code: supplier.code, name: supplier.name },
      });
      return supplier;
    });
  }

  async findAll(query: SupplierQueryDto): Promise<PaginatedResult<Supplier>> {
    const where: Prisma.SupplierWhereInput = query.search
      ? {
          OR: [
            { code: { contains: query.search, mode: 'insensitive' } },
            { name: { contains: query.search, mode: 'insensitive' } },
            { phone: { contains: query.search } },
          ],
        }
      : {};

    const { page, limit } = query;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.supplier.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { code: 'asc' },
      }),
      this.prisma.supplier.count({ where }),
    ]);
    return { data, meta: { page, limit, total } };
  }

  async findOne(id: string): Promise<Supplier> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateSupplierDto,
  ): Promise<Supplier> {
    await this.findOne(id);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.supplier.update({ where: { id }, data: dto });
      await this.audit.recordWith(tx, {
        actorUserId: user.id,
        branchId: null,
        entityType: 'Supplier',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        payload: { code: updated.code, fields: Object.keys(dto) },
      });
      return updated;
    });
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const existing = await this.prisma.supplier.findUnique({ where: { code } });
    if (existing) throw new ConflictException('Supplier code is already used');
  }
}
