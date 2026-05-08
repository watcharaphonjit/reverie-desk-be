import { Module } from '@nestjs/common';
import { TreatmentEntitlementsController } from './treatment-entitlements.controller';
import { TreatmentEntitlementsService } from './treatment-entitlements.service';

@Module({
  controllers: [TreatmentEntitlementsController],
  providers: [TreatmentEntitlementsService],
  exports: [TreatmentEntitlementsService],
})
export class TreatmentEntitlementsModule {}
