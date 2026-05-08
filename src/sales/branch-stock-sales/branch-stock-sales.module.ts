import { Module } from '@nestjs/common';
import { BranchStockSalesController } from './branch-stock-sales.controller';
import { BranchStockSalesService } from './branch-stock-sales.service';

@Module({
  controllers: [BranchStockSalesController],
  providers: [BranchStockSalesService],
  exports: [BranchStockSalesService],
})
export class BranchStockSalesModule {}
