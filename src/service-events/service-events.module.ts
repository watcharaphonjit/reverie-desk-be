import { Module } from '@nestjs/common';
import { TreatmentEntitlementsModule } from '../treatment-entitlements/treatment-entitlements.module';
import { ServiceEventsController } from './service-events.controller';
import { ServiceEventsService } from './service-events.service';

@Module({
  imports: [TreatmentEntitlementsModule],
  controllers: [ServiceEventsController],
  providers: [ServiceEventsService],
  exports: [ServiceEventsService],
})
export class ServiceEventsModule {}
