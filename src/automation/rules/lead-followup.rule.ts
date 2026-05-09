import { Injectable, Logger } from '@nestjs/common';
import { LeadStatus, NotificationType } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationConfigService } from '../automation.config';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

/**
 * Detects leads that have been in CONTACTED status with no `updatedAt`
 * change for more than `LEAD_FOLLOWUP_HOURS` (default 48). Notifies the
 * current owner.
 *
 * Dedup: per (lead, day) so the alert nags once a day at most until
 * the owner moves the lead forward.
 */
@Injectable()
export class LeadFollowupRule implements AutomationRule {
  readonly code = 'LEAD_FOLLOWUP';
  readonly description =
    'Every 4 hours — reminds owners about stale CONTACTED leads.';
  readonly schedule = '0 */4 * * *';

  private readonly logger = new Logger(LeadFollowupRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: AutomationConfigService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    const cutoff = new Date(
      Date.now() - this.config.leadFollowupHours * 3600_000,
    );
    const leads = await this.prisma.lead.findMany({
      where: {
        status: LeadStatus.CONTACTED,
        deletedAt: null,
        updatedAt: { lt: cutoff },
        currentOwnerUserId: { not: null },
      },
      select: {
        id: true,
        code: true,
        name: true,
        currentOwnerUserId: true,
        branchId: true,
        updatedAt: true,
      },
    });

    let created = 0;
    let skipped = 0;
    const today = new Date().toISOString().slice(0, 10);

    for (const lead of leads) {
      if (!lead.currentOwnerUserId) continue;
      const ageHrs = Math.floor(
        (Date.now() - lead.updatedAt.getTime()) / 3600_000,
      );
      const result = await this.notifications.notify({
        userId: lead.currentOwnerUserId,
        branchId: lead.branchId,
        title: `Lead follow-up overdue: ${lead.code}`,
        message: `Lead ${lead.code} (${lead.name}) has been in CONTACTED for ${ageHrs}h with no update.`,
        type: NotificationType.LEAD_FOLLOWUP,
        metadata: {
          leadId: lead.id,
          ageHours: ageHrs,
        },
        dedupeKey: `LEAD_FOLLOWUP|${lead.id}|${lead.currentOwnerUserId}|${today}`,
      });
      if (result.created) created++;
      else skipped++;
    }

    this.logger.debug(
      `${this.code}: stale=${leads.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}
