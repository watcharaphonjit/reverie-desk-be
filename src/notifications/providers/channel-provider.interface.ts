import { NotificationChannel } from '@prisma/client';

export interface NotificationDispatchInput {
  notificationId: string;
  userId: string | null;
  branchId: string | null;
  title: string;
  message: string;
  type: string;
  metadata: Record<string, unknown> | null;
}

export interface NotificationChannelProvider {
  /** Channel this provider handles. The registry keys on this. */
  readonly channel: NotificationChannel;
  /** Deliver a notification through this channel. Must not throw on
   *  network failures — log and return; the in-app DB row is the source
   *  of truth so partial delivery is acceptable. */
  dispatch(input: NotificationDispatchInput): Promise<void>;
}
