import { Global, Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * Wallet is global so payment, refund, and sales-order flows can post
 * ledger transactions inside their own `prisma.$transaction` via
 * {@link WalletService.creditWith} / {@link WalletService.debitWith}
 * without each consuming module having to import this one.
 */
@Global()
@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
