import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import {
  NotificationChannelProvider,
  NotificationDispatchInput,
} from './channel-provider.interface';

/**
 * Email provider stub — logs the would-be send. Replace `dispatch` with
 * a real transport (SES / SendGrid / etc.) when shipping. The shape of
 * `input` is stable, so the swap is a one-file change.
 */
@Injectable()
export class EmailNotificationProvider implements NotificationChannelProvider {
  readonly channel = NotificationChannel.EMAIL;
  private readonly logger = new Logger(EmailNotificationProvider.name);

  dispatch(input: NotificationDispatchInput): Promise<void> {
    this.logger.log(
      `[EMAIL stub] notif=${input.notificationId} user=${input.userId} type=${input.type} title="${input.title}"`,
    );
    return Promise.resolve();
  }
}
