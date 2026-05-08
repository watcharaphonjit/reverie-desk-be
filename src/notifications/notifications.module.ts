import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailNotificationProvider } from './providers/email.provider';
import { InAppNotificationProvider } from './providers/in-app.provider';
import {
  NOTIFICATION_CHANNEL_PROVIDERS,
  NotificationProviderRegistry,
} from './providers/registry';
import { SmsNotificationProvider } from './providers/sms.provider';

/**
 * Marked `@Global()` so any module (Payments / Refunds / etc.) can
 * inject `NotificationsService` directly without re-importing.
 *
 * Channel providers are bundled here as concrete instances; the
 * registry collects them via DI through the
 * `NOTIFICATION_CHANNEL_PROVIDERS` token. To add a new channel: register
 * the provider class, add a `useFactory` entry below, and the dispatcher
 * will pick it up automatically.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    InAppNotificationProvider,
    EmailNotificationProvider,
    SmsNotificationProvider,
    {
      provide: NOTIFICATION_CHANNEL_PROVIDERS,
      useFactory: (
        inApp: InAppNotificationProvider,
        email: EmailNotificationProvider,
        sms: SmsNotificationProvider,
      ) => [inApp, email, sms],
      inject: [
        InAppNotificationProvider,
        EmailNotificationProvider,
        SmsNotificationProvider,
      ],
    },
    NotificationProviderRegistry,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
