import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { BranchesService } from '../branches/branches.service';
import { AuditService } from '../common/services/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

interface SettingsPayload {
  general: {
    organizationName: string;
    timezone: string;
    defaultBranchId: string | null;
    reportWindowDays: number;
  };
  finance: {
    commissionLockDay: number;
    walletExpiryReminderDays: number;
    outstandingWarningThreshold: number;
  };
  inventory: {
    lowStockThreshold: number;
    nearExpiryDays: number;
  };
  notifications: {
    enableInApp: boolean;
    enableEmail: boolean;
    enableSms: boolean;
    dailyDigestHour: number;
  };
  automation: {
    appointmentReminderHours: number;
    leadFollowUpDays: number;
    enableDailyDigest: boolean;
  };
}

const DEFAULT_SYSTEM_SETTINGS: SettingsPayload = {
  general: {
    organizationName: 'Reverie Desk',
    timezone: 'Asia/Bangkok',
    defaultBranchId: null as string | null,
    reportWindowDays: 30,
  },
  finance: {
    commissionLockDay: 25,
    walletExpiryReminderDays: 14,
    outstandingWarningThreshold: 5000,
  },
  inventory: {
    lowStockThreshold: 5,
    nearExpiryDays: 30,
  },
  notifications: {
    enableInApp: true,
    enableEmail: false,
    enableSms: false,
    dailyDigestHour: 9,
  },
  automation: {
    appointmentReminderHours: 24,
    leadFollowUpDays: 3,
    enableDailyDigest: false,
  },
};
type SettingsSectionKey = keyof SettingsPayload;

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branches: BranchesService,
    private readonly audit: AuditService,
  ) {}

  async getAll(): Promise<SettingsPayload> {
    const rows = await this.prisma.systemSetting.findMany({
      where: { key: { in: this.sectionKeys() } },
    });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    return {
      general: this.mergeSection('general', byKey),
      finance: this.mergeSection('finance', byKey),
      inventory: this.mergeSection('inventory', byKey),
      notifications: this.mergeSection('notifications', byKey),
      automation: this.mergeSection('automation', byKey),
    };
  }

  async update(
    actor: AuthenticatedUser,
    dto: UpdateSettingsDto,
  ): Promise<SettingsPayload> {
    const updates = Object.entries(dto).filter(
      ([, value]) => value !== undefined,
    ) as Array<[SettingsSectionKey, SettingsPayload[SettingsSectionKey]]>;

    if (updates.length === 0) {
      return this.getAll();
    }

    if (dto.general?.defaultBranchId) {
      await this.branches.validateBranchActive(dto.general.defaultBranchId);
    }

    const current = await this.getAll();
    const next = {
      general: {
        ...current.general,
        ...(dto.general ?? {}),
      },
      finance: {
        ...current.finance,
        ...(dto.finance ?? {}),
      },
      inventory: {
        ...current.inventory,
        ...(dto.inventory ?? {}),
      },
      notifications: {
        ...current.notifications,
        ...(dto.notifications ?? {}),
      },
      automation: {
        ...current.automation,
        ...(dto.automation ?? {}),
      },
    } satisfies SettingsPayload;

    await this.prisma.$transaction(async (tx) => {
      for (const [section] of updates) {
        await tx.systemSetting.upsert({
          where: { key: section },
          create: {
            key: section,
            value: next[section],
            updatedByUserId: actor.id,
          },
          update: {
            value: next[section],
            updatedByUserId: actor.id,
          },
        });
      }

      await this.audit.recordWith(tx, {
        actorUserId: actor.id,
        branchId: actor.branchId,
        entityType: 'SystemSetting',
        entityId: 'global',
        action: AuditAction.UPDATE,
        payload: {
          sections: updates.map(([section]) => section),
        },
      });
    });

    return next;
  }

  private mergeSection<K extends SettingsSectionKey>(
    key: K,
    rows: Map<string, Prisma.JsonValue>,
  ): SettingsPayload[K] {
    const stored = rows.get(key);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      return { ...DEFAULT_SYSTEM_SETTINGS[key] };
    }
    return {
      ...DEFAULT_SYSTEM_SETTINGS[key],
      ...(stored as Record<string, unknown>),
    };
  }

  private sectionKeys(): SettingsSectionKey[] {
    return Object.keys(DEFAULT_SYSTEM_SETTINGS) as SettingsSectionKey[];
  }
}

export type { SettingsPayload };
