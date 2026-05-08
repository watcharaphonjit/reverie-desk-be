import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import {
  NotificationChannelProvider,
  NotificationDispatchInput,
} from './channel-provider.interface';

/**
 * In-app provider — no external delivery. The notification row already
 * exists in the DB at this point (the service writes it before
 * dispatching) so this is essentially a no-op acknowledgement that lets
 * the dispatcher loop stay symmetrical across channels.
 */
@Injectable()
export class InAppNotificationProvider implements NotificationChannelProvider {
  readonly channel = NotificationChannel.IN_APP;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async dispatch(_input: NotificationDispatchInput): Promise<void> {
    // intentional no-op: storing the row is the delivery
  }
}
