import { Global, Module } from '@nestjs/common';
import { AutomationConfigService } from './automation.config';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { RecipientsService } from './recipients.service';
import { AppointmentReminderRule } from './rules/appointment-reminder.rule';
import { CommissionEligibleRule } from './rules/commission-eligible.rule';
import { DepositPendingRule } from './rules/deposit-pending.rule';
import { ExpiringStockRule } from './rules/expiring-stock.rule';
import { LeadFollowupRule } from './rules/lead-followup.rule';
import { LowStockRule } from './rules/low-stock.rule';
import { RefundApprovalRule } from './rules/refund-approval.rule';
import { WalletExpiryRule } from './rules/wallet-expiry.rule';

@Global()
@Module({
  controllers: [AutomationController],
  providers: [
    AutomationConfigService,
    RecipientsService,
    DepositPendingRule,
    AppointmentReminderRule,
    LowStockRule,
    ExpiringStockRule,
    RefundApprovalRule,
    CommissionEligibleRule,
    WalletExpiryRule,
    LeadFollowupRule,
    AutomationService,
  ],
  exports: [AutomationService, AutomationConfigService],
})
export class AutomationModule {}
