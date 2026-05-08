import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  Prisma,
  Wallet,
  WalletReferenceType,
  WalletTransaction,
  WalletTransactionType,
  WalletType,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreditWalletDto } from './dto/credit-wallet.dto';
import { DebitWalletDto } from './dto/debit-wallet.dto';
import { TransferWalletDto } from './dto/transfer-wallet.dto';

export interface WalletPostingInput {
  customerId: string;
  walletType: WalletType;
  amount: number;
  type: WalletTransactionType;
  referenceType?: WalletReferenceType | null;
  referenceId?: string | null;
  branchId?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  actorUserId: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const decToNum = (v: Prisma.Decimal | number | null | undefined): number => {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
};

/**
 * Wallet service – handles per-customer ledger balances.
 *
 * The two `*With` helpers exist so payment/refund/sales-order flows can post
 * a wallet transaction inside the *same* `prisma.$transaction` they're
 * already running, keeping balance updates atomic with the business write
 * that triggered them. Public endpoints (`credit`, `debit`, `transfer`) use
 * the same helpers under their own `prisma.$transaction`.
 *
 * Wallet rows are auto-created on first credit (one row per
 * (customer, walletType) pair, enforced by a unique index in the schema).
 * Debits never auto-create — debiting a non-existent wallet is a 400.
 */
@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────── public APIs ─────────────────────────

  async listForCustomer(customerId: string): Promise<Wallet[]> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return this.prisma.wallet.findMany({
      where: { customerId },
      orderBy: [{ type: 'asc' }],
    });
  }

  async credit(
    user: AuthenticatedUser,
    dto: CreditWalletDto,
  ): Promise<{ wallet: Wallet; transaction: WalletTransaction }> {
    return this.prisma.$transaction((tx) =>
      this.creditWith(tx, {
        customerId: dto.customerId,
        walletType: dto.walletType ?? WalletType.DEPOSIT,
        amount: dto.amount,
        type: WalletTransactionType.CREDIT,
        referenceType: dto.referenceType ?? WalletReferenceType.MANUAL,
        referenceId: dto.referenceId ?? null,
        branchId: dto.branchId ?? user.branchId,
        note: dto.note ?? null,
        actorUserId: user.id,
      }),
    );
  }

  async debit(
    user: AuthenticatedUser,
    dto: DebitWalletDto,
  ): Promise<{ wallet: Wallet; transaction: WalletTransaction }> {
    return this.prisma.$transaction((tx) =>
      this.debitWith(tx, {
        customerId: dto.customerId,
        walletType: dto.walletType ?? WalletType.DEPOSIT,
        amount: dto.amount,
        type: WalletTransactionType.DEBIT,
        referenceType: dto.referenceType ?? WalletReferenceType.MANUAL,
        referenceId: dto.referenceId ?? null,
        branchId: dto.branchId ?? user.branchId,
        note: dto.note ?? null,
        actorUserId: user.id,
      }),
    );
  }

  async transfer(
    user: AuthenticatedUser,
    dto: TransferWalletDto,
  ): Promise<{
    out: { wallet: Wallet; transaction: WalletTransaction };
    in: { wallet: Wallet; transaction: WalletTransaction };
  }> {
    if (
      dto.fromCustomerId === dto.toCustomerId &&
      (dto.fromWalletType ?? WalletType.DEPOSIT) ===
        (dto.toWalletType ?? WalletType.DEPOSIT)
    ) {
      throw new BadRequestException(
        'Source and destination wallets must differ',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const referenceId = `transfer-${Date.now()}-${user.id.slice(0, 6)}`;
      const out = await this.debitWith(tx, {
        customerId: dto.fromCustomerId,
        walletType: dto.fromWalletType ?? WalletType.DEPOSIT,
        amount: dto.amount,
        type: WalletTransactionType.TRANSFER_OUT,
        referenceType: WalletReferenceType.MANUAL,
        referenceId,
        branchId: dto.branchId ?? user.branchId,
        note: dto.note ?? null,
        actorUserId: user.id,
        metadata: {
          transferTo: {
            customerId: dto.toCustomerId,
            walletType: dto.toWalletType ?? WalletType.DEPOSIT,
          },
        },
      });
      const inTxn = await this.creditWith(tx, {
        customerId: dto.toCustomerId,
        walletType: dto.toWalletType ?? WalletType.DEPOSIT,
        amount: dto.amount,
        type: WalletTransactionType.TRANSFER_IN,
        referenceType: WalletReferenceType.MANUAL,
        referenceId,
        branchId: dto.branchId ?? user.branchId,
        note: dto.note ?? null,
        actorUserId: user.id,
        metadata: {
          transferFrom: {
            customerId: dto.fromCustomerId,
            walletType: dto.fromWalletType ?? WalletType.DEPOSIT,
          },
        },
      });
      return { out, in: inTxn };
    });
  }

  // ─────────────────────── tx-aware helpers ───────────────────────

  /**
   * Credit a wallet inside a caller-supplied transaction. Auto-creates the
   * wallet row on first credit. Returns the updated wallet + the resulting
   * transaction row.
   */
  async creditWith(
    tx: Prisma.TransactionClient,
    input: WalletPostingInput,
  ): Promise<{ wallet: Wallet; transaction: WalletTransaction }> {
    if (input.amount <= 0) {
      throw new BadRequestException('Wallet amount must be > 0');
    }
    const amount = round2(input.amount);
    const wallet = await this.lockOrCreateWallet(
      tx,
      input.customerId,
      input.walletType,
    );
    const balanceBefore = decToNum(wallet.balance);
    const balanceAfter = round2(balanceBefore + amount);

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: new Prisma.Decimal(balanceAfter) },
    });

    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        branchId: input.branchId ?? null,
        createdByUserId: input.actorUserId ?? null,
        type: input.type,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        amount: new Prisma.Decimal(amount),
        balanceBefore: new Prisma.Decimal(balanceBefore),
        balanceAfter: new Prisma.Decimal(balanceAfter),
        note: input.note ?? null,
        metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });

    await this.audit.recordWith(tx, {
      actorUserId: input.actorUserId,
      branchId: input.branchId ?? null,
      entityType: 'Wallet',
      entityId: wallet.id,
      action: AuditAction.UPDATE,
      payload: {
        op: 'credit',
        type: input.type,
        amount,
        balanceBefore,
        balanceAfter,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        walletType: input.walletType,
        customerId: input.customerId,
        transactionId: transaction.id,
      },
    });

    return { wallet: updated, transaction };
  }

  /**
   * Debit a wallet inside a caller-supplied transaction. Throws on
   * insufficient balance — the row is locked beforehand so the balance
   * check is race-free.
   */
  async debitWith(
    tx: Prisma.TransactionClient,
    input: WalletPostingInput,
  ): Promise<{ wallet: Wallet; transaction: WalletTransaction }> {
    if (input.amount <= 0) {
      throw new BadRequestException('Wallet amount must be > 0');
    }
    const amount = round2(input.amount);
    const wallet = await this.lockExistingWallet(
      tx,
      input.customerId,
      input.walletType,
    );
    const balanceBefore = decToNum(wallet.balance);
    if (balanceBefore + 1e-9 < amount) {
      throw new BadRequestException(
        `Wallet balance ${balanceBefore} is insufficient for debit ${amount}`,
      );
    }
    const balanceAfter = round2(balanceBefore - amount);

    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: new Prisma.Decimal(balanceAfter) },
    });

    const transaction = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        branchId: input.branchId ?? null,
        createdByUserId: input.actorUserId ?? null,
        type: input.type,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        amount: new Prisma.Decimal(amount),
        balanceBefore: new Prisma.Decimal(balanceBefore),
        balanceAfter: new Prisma.Decimal(balanceAfter),
        note: input.note ?? null,
        metadata: (input.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });

    await this.audit.recordWith(tx, {
      actorUserId: input.actorUserId,
      branchId: input.branchId ?? null,
      entityType: 'Wallet',
      entityId: wallet.id,
      action: AuditAction.UPDATE,
      payload: {
        op: 'debit',
        type: input.type,
        amount,
        balanceBefore,
        balanceAfter,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        walletType: input.walletType,
        customerId: input.customerId,
        transactionId: transaction.id,
      },
    });

    return { wallet: updated, transaction };
  }

  // ───────────────────────── internals ─────────────────────────

  /**
   * Lock the wallet row (or create it on first touch) so concurrent credits
   * to the same wallet serialize cleanly. We use a Postgres advisory lock
   * keyed by the unique (customerId, walletType) pair before the upsert,
   * because the wallet row may not exist yet (and `SELECT FOR UPDATE` can't
   * lock a row that isn't there).
   */
  private async lockOrCreateWallet(
    tx: Prisma.TransactionClient,
    customerId: string,
    walletType: WalletType,
  ): Promise<Wallet> {
    const lockKey = `wallet:${customerId}:${walletType}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const existing = await tx.wallet.findUnique({
      where: {
        customerId_type: { customerId, type: walletType },
      },
    });
    if (existing) return existing;

    const customer = await tx.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');

    return tx.wallet.create({
      data: {
        customerId,
        type: walletType,
        balance: new Prisma.Decimal(0),
        currency: 'THB',
        isActive: true,
      },
    });
  }

  private async lockExistingWallet(
    tx: Prisma.TransactionClient,
    customerId: string,
    walletType: WalletType,
  ): Promise<Wallet> {
    const lockKey = `wallet:${customerId}:${walletType}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const wallet = await tx.wallet.findUnique({
      where: {
        customerId_type: { customerId, type: walletType },
      },
    });
    if (!wallet) {
      throw new NotFoundException(
        `Wallet ${walletType} for customer ${customerId} not found`,
      );
    }
    if (!wallet.isActive) {
      throw new BadRequestException('Wallet is inactive');
    }
    return wallet;
  }
}
