import { Module } from '@nestjs/common';
import { RefundsController } from './refunds.controller';
import { RefundsService } from './refunds.service';

/**
 * `WalletModule` and `CommissionsModule` are both `@Global`, so the
 * service can inject `WalletService` + `CommissionsService` here without
 * an explicit `imports:` array.
 */
@Module({
  controllers: [RefundsController],
  providers: [RefundsService],
  exports: [RefundsService],
})
export class RefundsModule {}
