import { Module } from '@nestjs/common';
import { StockItemsController } from './stock-items.controller';
import { StockItemsService } from './stock-items.service';

@Module({
  controllers: [StockItemsController],
  providers: [StockItemsService],
  exports: [StockItemsService],
})
export class StockItemsModule {}
