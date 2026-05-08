import { Global, Module } from '@nestjs/common';
import { CommissionRulesController } from './commission-rules.controller';
import { CommissionRulesService } from './commission-rules.service';
import { CommissionsController } from './commissions.controller';
import { CommissionsService } from './commissions.service';

/**
 * Marked global so payments + sales-orders + refunds modules can call into
 * the engine (e.g. `evaluateOrderWith(tx, ...)`, `revokeForOrderWith(tx, ...)`)
 * without each importing this module.
 */
@Global()
@Module({
  controllers: [CommissionRulesController, CommissionsController],
  providers: [CommissionRulesService, CommissionsService],
  exports: [CommissionRulesService, CommissionsService],
})
export class CommissionsModule {}
