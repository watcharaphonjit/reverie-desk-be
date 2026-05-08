import { Module } from '@nestjs/common';
import { TargetProgressService } from './target-progress.service';
import { TargetsController } from './targets.controller';
import { TargetsService } from './targets.service';

@Module({
  controllers: [TargetsController],
  providers: [TargetsService, TargetProgressService],
  exports: [TargetsService, TargetProgressService],
})
export class TargetsModule {}
