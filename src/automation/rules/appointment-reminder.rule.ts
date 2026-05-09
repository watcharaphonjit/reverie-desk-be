import { Injectable, Logger } from '@nestjs/common';
import { AppointmentStatus, NotificationType } from '@prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationConfigService } from '../automation.config';
import {
  AutomationRule,
  AutomationRuleResult,
} from './automation-rule.interface';

/**
 * Appointments scheduled within the configured reminder window
 * (default 24h). Notify the assigned doctor + the booking creator.
 * Dedup key uses the appointment id + scheduled-day so rerunning the
 * rule within the day does not double-fire.
 */
@Injectable()
export class AppointmentReminderRule implements AutomationRule {
  readonly code = 'APPOINTMENT_REMINDER';
  readonly description =
    'Every 30 min — reminds doctor & creator about appointments in the next 24h.';
  readonly schedule = '*/30 * * * *';

  private readonly logger = new Logger(AppointmentReminderRule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: AutomationConfigService,
  ) {}

  async execute(): Promise<AutomationRuleResult> {
    const now = new Date();
    const cutoff = new Date(
      now.getTime() + this.config.appointmentReminderWindowHours * 3600_000,
    );
    const candidates = await this.prisma.appointment.findMany({
      where: {
        status: AppointmentStatus.BOOKED,
        scheduledAt: { gte: now, lte: cutoff },
      },
      select: {
        id: true,
        appointmentNo: true,
        scheduledAt: true,
        branchId: true,
        doctorUserId: true,
        createdByUserId: true,
        customer: { select: { fullName: true } },
        service: { select: { name: true } },
      },
    });

    let created = 0;
    let skipped = 0;
    for (const a of candidates) {
      const recipients = new Set<string>();
      if (a.doctorUserId) recipients.add(a.doctorUserId);
      if (a.createdByUserId) recipients.add(a.createdByUserId);
      if (recipients.size === 0) continue;

      const dayBucket = a.scheduledAt.toISOString().slice(0, 13); // hourly bucket
      const result = await this.notifications.notifyMany(
        Array.from(recipients),
        {
          title: `Appointment soon — ${a.appointmentNo}`,
          message: `${a.customer.fullName} is booked for ${a.service.name} at ${a.scheduledAt.toISOString()}.`,
          type: NotificationType.APPOINTMENT_REMINDER,
          branchId: a.branchId,
          metadata: {
            appointmentId: a.id,
            scheduledAt: a.scheduledAt.toISOString(),
          },
          dedupeKeyPrefix: `APPOINTMENT_REMINDER|${a.id}|${dayBucket}`,
        },
      );
      created += result.created;
      skipped += result.skipped;
    }

    this.logger.debug(
      `${this.code}: scanned=${candidates.length} created=${created} skipped=${skipped}`,
    );
    return { created, skipped };
  }
}
