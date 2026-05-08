import { Module } from '@nestjs/common';
import { TreatmentEntitlementsModule } from '../treatment-entitlements/treatment-entitlements.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [TreatmentEntitlementsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
