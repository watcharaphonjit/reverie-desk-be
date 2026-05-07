import { Module } from '@nestjs/common';
import { ExpirySweepController } from './expiry-sweep.controller';
import { ExpirySweepService } from './expiry-sweep.service';

@Module({
  controllers: [ExpirySweepController],
  providers: [ExpirySweepService],
  exports: [ExpirySweepService],
})
export class ExpirySweepModule {}
