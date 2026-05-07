import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { CommonModule } from './common/common.module';
import { CustomerModule } from './customer/customer.module';
import { LeadsModule } from './leads/leads.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { SalesOrdersModule } from './sales-orders/sales-orders.module';
import { PaymentsModule } from './payments/payments.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { ServiceEventsModule } from './service-events/service-events.module';
import { UnitsModule } from './inventory/units/units.module';
import { StockItemsModule } from './inventory/stock-items/stock-items.module';
import { SuppliersModule } from './inventory/suppliers/suppliers.module';
import { PurchaseReceiptsModule } from './inventory/purchase-receipts/purchase-receipts.module';
import { StockLotsModule } from './inventory/stock-lots/stock-lots.module';
import { OpenedContainersModule } from './inventory/opened-containers/opened-containers.module';
import { StockTransfersModule } from './inventory/stock-transfers/stock-transfers.module';
import { ExpirySweepModule } from './inventory/expiry-sweep/expiry-sweep.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    BranchesModule,
    AuthModule,
    UsersModule,
    CustomerModule,
    LeadsModule,
    SalesOrdersModule,
    PaymentsModule,
    AppointmentsModule,
    ServiceEventsModule,
    UnitsModule,
    StockItemsModule,
    SuppliersModule,
    PurchaseReceiptsModule,
    StockLotsModule,
    OpenedContainersModule,
    StockTransfersModule,
    ExpirySweepModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
