import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma, WalletTransactionType } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationConfigService } from '../automation.config';
import { RecipientsService } from '../recipients.service';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

/**
 * Wallet expiry uses an opt-in metadata pattern: any CREDIT transaction
 * may carry `metadata.expiresAt` (ISO timestamp). When that timestamp
 * falls within `WALLET_EXPIRY_NOTICE_DAYS` of now, this rule flags the
 * branch's CS team (Customer entity has no User relation, so we
 * notify branch managers instead so they can reach out manually).
 *
 * If no transactions in the system carry expiry metadata, the rule is
 * a no-op.
 */
@Injectable()
export class WalletExpiryRule implements AutomationRule {
  readonly code = 'WALLET_EXPIRY';
  readonly description =
    'Daily — flags wallet credits about to expire.';
  readonly schedule = '0 9 * * *';

  private readonly logger = new Logger(WalletExpiryRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: AutomationConfigService,
    private readonly recipients: RecipientsService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    // Pull recent CREDIT transactions and inspect metadata in code.
    // We bound the lookup to one year — more than enough head-room.
    const lookback = new Date();
    lookback.setFullYear(lookback.getFullYear() - 1);

    const txns = await this.prisma.walletTransaction.findMany({
      where: {
        type: WalletTransactionType.CREDIT,
        createdAt: { gte: lookback },
        NOT: { metadata: { equals: Prisma.DbNull } },
      },
      select: {
        id: true,
        walletId: true,
        amount: true,
        metadata: true,
        branchId: true,
        wallet: {
          select: {
            customerId: true,
            customer: {
              select: { fullName: true, currentBranchId: true },
            },
          },
        },
      },
    });

    const now = new Date();
    const cutoff = new Date(
      now.getTime() + this.config.walletExpiryNoticeDays * 86_400_000,
    );

    let created = 0;
    let skipped = 0;

    for (const t of txns) {
      const meta = t.metadata as Record<string, unknown> | null;
      const raw = meta && typeof meta.expiresAt === 'string'
        ? meta.expiresAt
        : null;
      if (!raw) continue;
      const exp = new Date(raw);
      if (Number.isNaN(exp.getTime())) continue;
      if (exp < now || exp > cutoff) continue;

      const branchId =
        t.branchId ?? t.wallet.customer.currentBranchId ?? null;
      const recipients = branchId
        ? await this.recipients.branchManagers(branchId)
        : [];
      if (recipients.length === 0) continue;

      const days = Math.ceil((exp.getTime() - now.getTime()) / 86_400_000);
      const result = await this.notifications.notifyMany(recipients, {
        title: `Wallet credit expiring: ${t.wallet.customer.fullName}`,
        message: `${t.amount} credit for ${t.wallet.customer.fullName} expires in ${days}d.`,
        type: NotificationType.WALLET_EXPIRY,
        branchId,
        metadata: {
          walletTransactionId: t.id,
          walletId: t.walletId,
          customerId: t.wallet.customerId,
          expiresAt: exp.toISOString(),
        } as Prisma.InputJsonValue,
        dedupeKeyPrefix: `WALLET_EXPIRY|${t.id}|${exp
          .toISOString()
          .slice(0, 10)}`,
      });
      created += result.created;
      skipped += result.skipped;
    }

    this.logger.debug(
      `${this.code}: candidates=${txns.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}
