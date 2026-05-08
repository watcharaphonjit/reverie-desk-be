import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Prisma, RoleCode } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BranchesService } from '../branches/branches.service';
import {
  assertBranchAccess,
  isUnrestricted,
} from '../common/authz/branch-scope';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const BCRYPT_ROUNDS = 12;

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  phone: true,
  fullName: true,
  branchId: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{ select: typeof SAFE_USER_SELECT }>;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branches: BranchesService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── create ─────────────────────────
  async create(dto: CreateUserDto): Promise<SafeUser> {
    const { roles = [], password, ...rest } = dto;

    const emailTaken = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { id: true },
    });
    if (emailTaken) throw new ConflictException('Email already registered');

    if (rest.branchId) await this.branches.validateBranchActive(rest.branchId);

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { ...rest, passwordHash },
        select: SAFE_USER_SELECT,
      });

      if (roles.length === 0) return user;

      const roleRows = await tx.role.findMany({
        where: { code: { in: roles } },
        select: { id: true, code: true },
      });
      if (roleRows.length !== roles.length) {
        throw new BadRequestException('One or more role codes are invalid');
      }

      await tx.userRole.createMany({
        data: roleRows.map((r) => ({
          userId: user.id,
          roleId: r.id,
          branchId: user.branchId,
        })),
        skipDuplicates: true,
      });

      return user;
    });
  }

  // ───────────────────────── list (branch-scoped) ─────────────────────────
  async findAll(actor: AuthenticatedUser): Promise<SafeUser[]> {
    return this.prisma.user.findMany({
      where: { branchId: this.resolveBranchFilter(actor, undefined) },
      select: SAFE_USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByBranch(
    actor: AuthenticatedUser,
    branchId: string,
  ): Promise<SafeUser[]> {
    assertBranchAccess(actor, branchId);
    return this.prisma.user.findMany({
      where: { branchId },
      select: SAFE_USER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  // ───────────────────────── detail ─────────────────────────
  async findOne(actor: AuthenticatedUser, id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...SAFE_USER_SELECT,
        userRoles: {
          select: { role: { select: { code: true } } },
        },
        branch: { select: { id: true, code: true, name: true } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    assertBranchAccess(actor, user.branchId);

    const { userRoles, ...rest } = user;
    return {
      ...rest,
      roles: userRoles.map((ur) => ur.role.code),
    };
  }

  // ───────────────────────── update ─────────────────────────
  async update(
    actor: AuthenticatedUser,
    id: string,
    dto: UpdateUserDto,
  ): Promise<SafeUser> {
    const existing = await this.requireUser(id);
    assertBranchAccess(actor, existing.branchId);
    if (dto.branchId) await this.branches.validateBranchActive(dto.branchId);
    return this.prisma.user.update({
      where: { id },
      data: dto,
      select: SAFE_USER_SELECT,
    });
  }

  // ───────────────────────── assign-branch ─────────────────────────
  async assignBranch(
    actor: AuthenticatedUser,
    id: string,
    branchId: string,
  ): Promise<SafeUser> {
    const existing = await this.requireUser(id);
    await this.branches.validateBranchActive(branchId);

    if (existing.branchId === branchId) {
      return this.prisma.user.findUniqueOrThrow({
        where: { id },
        select: SAFE_USER_SELECT,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { branchId },
        select: SAFE_USER_SELECT,
      });

      await this.audit.recordWith(tx, {
        actorUserId: actor.id,
        branchId,
        entityType: 'User',
        entityId: id,
        action: AuditAction.ASSIGN,
        payload: {
          field: 'branchId',
          from: existing.branchId,
          to: branchId,
        },
      });

      return updated;
    });
  }

  // ───────────────────────── unassign-branch ─────────────────────────
  async unassignBranch(
    actor: AuthenticatedUser,
    id: string,
  ): Promise<SafeUser> {
    const existing = await this.requireUser(id);
    if (existing.branchId === null) {
      return this.prisma.user.findUniqueOrThrow({
        where: { id },
        select: SAFE_USER_SELECT,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { branchId: null },
        select: SAFE_USER_SELECT,
      });

      await this.audit.recordWith(tx, {
        actorUserId: actor.id,
        branchId: existing.branchId,
        entityType: 'User',
        entityId: id,
        action: AuditAction.REVOKE,
        payload: {
          field: 'branchId',
          from: existing.branchId,
          to: null,
        },
      });

      return updated;
    });
  }

  // ───────────────────────── used by AuthService ─────────────────────────
  /** Returns the full user row including passwordHash. */
  async findByEmailWithSecret(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async getRoleCodes(userId: string): Promise<RoleCode[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: { role: { select: { code: true } } },
    });
    return rows.map((r) => r.role.code);
  }

  /**
   * Resolve a user's effective permission set as a flat list of codes,
   * deduped across roles. One indexed query joining
   * userRoles → role → rolePermissions → permission.
   */
  async getPermissionCodes(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { userId },
      select: {
        role: {
          select: {
            rolePermissions: {
              select: { permission: { select: { code: true } } },
            },
          },
        },
      },
    });
    const set = new Set<string>();
    for (const ur of rows) {
      for (const rp of ur.role.rolePermissions) {
        set.add(rp.permission.code);
      }
    }
    return Array.from(set);
  }

  // ───────────────────────── helpers ─────────────────────────
  private async requireUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, branchId: true, status: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Branch-scoped roles must always be filtered to their own branch.
   * Returns `undefined` for unrestricted roles (no filter); the caller's
   * branchId for branch-scoped roles. Throws if a branch-scoped caller has
   * no branch assignment, since otherwise the query would silently leak.
   */
  private resolveBranchFilter(
    actor: AuthenticatedUser,
    requested: string | undefined,
  ): string | undefined {
    if (isUnrestricted(actor)) return requested;
    if (!actor.branchId) {
      throw new ForbiddenException('User has no branch assignment');
    }
    return actor.branchId;
  }
}
