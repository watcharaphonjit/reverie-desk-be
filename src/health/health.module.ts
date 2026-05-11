import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { ApiHealthController } from './api-health.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController, ApiHealthController],
})
export class HealthModule {}
