import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import {
  NotificationChannelProvider,
  NotificationDispatchInput,
} from './channel-provider.interface';

/**
 * SMS provider stub — logs the would-be send. Replace `dispatch` with a
 * real SMS gateway (Twilio / Vonage / etc.) when shipping.
 */
@Injectable()
export class SmsNotificationProvider implements NotificationChannelProvider {
  readonly channel = NotificationChannel.SMS;
  private readonly logger = new Logger(SmsNotificationProvider.name);

  dispatch(input: NotificationDispatchInput): Promise<void> {
    this.logger.log(
      `[SMS stub] notif=${input.notificationId} user=${input.userId} type=${input.type} title="${input.title}"`,
    );
    return Promise.resolve();
  }
}
