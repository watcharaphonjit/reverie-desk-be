/**
 * Queue name constants. Defining these as values rather than ad-hoc
 * strings keeps producers and consumers in sync when names are renamed.
 */
export const QUEUE_NAMES = {
  notification: 'notification',
  automation: 'automation',
  reporting: 'reporting',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Notification job payloads. The dispatcher decides which channel
 * provider runs based on `channel`.
 */
export interface NotificationJobData {
  notificationId: string;
  channel: 'IN_APP' | 'EMAIL' | 'SMS';
}

/** Trigger an automation rule by code. */
export interface AutomationJobData {
  ruleCode: string;
  triggeredAt: string;
}

/** Pre-compute a report and (optionally) cache the result. */
export interface ReportingJobData {
  reportType: string;
  filters: Record<string, unknown>;
  cacheKey?: string;
  cacheTtl?: number;
}
