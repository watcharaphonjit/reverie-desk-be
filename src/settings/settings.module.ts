import { Module } from '@nestjs/common';
import { BranchesModule } from '../branches/branches.module';
import { CommonModule } from '../common/common.module';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [BranchesModule, CommonModule],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
