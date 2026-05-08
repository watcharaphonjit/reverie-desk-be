import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

/**
 * `ScheduleModule.forRoot()` is registered globally in `AppModule`, so
 * here we only declare the cron handlers themselves.
 */
@Module({
  providers: [SchedulerService],
})
export class JobsModule {}
