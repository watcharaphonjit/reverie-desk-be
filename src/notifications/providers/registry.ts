import { Inject, Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { NotificationChannelProvider } from './channel-provider.interface';

export const NOTIFICATION_CHANNEL_PROVIDERS = Symbol(
  'NOTIFICATION_CHANNEL_PROVIDERS',
);

/**
 * Single-source-of-truth lookup for a channel's provider. Channels not
 * registered here resolve to `undefined`, in which case the dispatcher
 * skips them silently. This is intentional: a deployment may opt out of
 * email/SMS by simply not registering those providers.
 */
@Injectable()
export class NotificationProviderRegistry {
  private readonly byChannel = new Map<
    NotificationChannel,
    NotificationChannelProvider
  >();

  constructor(
    @Inject(NOTIFICATION_CHANNEL_PROVIDERS)
    providers: NotificationChannelProvider[],
  ) {
    for (const p of providers) {
      this.byChannel.set(p.channel, p);
    }
  }

  resolve(
    channel: NotificationChannel,
  ): NotificationChannelProvider | undefined {
    return this.byChannel.get(channel);
  }

  channels(): NotificationChannel[] {
    return Array.from(this.byChannel.keys());
  }
}
