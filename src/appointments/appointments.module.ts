import { Module } from '@nestjs/common';
import { TreatmentEntitlementsModule } from '../treatment-entitlements/treatment-entitlements.module';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

@Module({
  imports: [TreatmentEntitlementsModule],
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
