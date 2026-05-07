import { Module } from '@nestjs/common';
import { ServiceEventsController } from './service-events.controller';
import { ServiceEventsService } from './service-events.service';

@Module({
  controllers: [ServiceEventsController],
  providers: [ServiceEventsService],
  exports: [ServiceEventsService],
})
export class ServiceEventsModule {}
