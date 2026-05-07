import { Global, Module } from '@nestjs/common';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

/**
 * Marked @Global so any future module (Leads, Users, Sales Orders, …) can
 * inject {@link BranchesService} for `validateBranchActive(branchId)` without
 * re-importing this module.
 */
@Global()
@Module({
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
