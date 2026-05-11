import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import redisConfig from './config/redis.config';
import { envValidationSchema } from './config/env.validation';
import { buildPinoOptions } from './common/logging/pino.options';
import { CacheModule } from './cache/cache.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
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
import { TreatmentEntitlementsModule } from './treatment-entitlements/treatment-entitlements.module';
import { ServiceEventsModule } from './service-events/service-events.module';
import { UnitsModule } from './inventory/units/units.module';
import { StockItemsModule } from './inventory/stock-items/stock-items.module';
import { SuppliersModule } from './inventory/suppliers/suppliers.module';
import { PurchaseReceiptsModule } from './inventory/purchase-receipts/purchase-receipts.module';
import { StockLotsModule } from './inventory/stock-lots/stock-lots.module';
import { OpenedContainersModule } from './inventory/opened-containers/opened-containers.module';
import { StockTransfersModule } from './inventory/stock-transfers/stock-transfers.module';
import { StockMovementsModule } from './inventory/stock-movements/stock-movements.module';
import { WarehousesModule } from './inventory/warehouses/warehouses.module';
import { ExpirySweepModule } from './inventory/expiry-sweep/expiry-sweep.module';
import { BranchStockSalesModule } from './sales/branch-stock-sales/branch-stock-sales.module';
import { ServicesModule } from './services/services.module';
import { CommissionsModule } from './commissions/commissions.module';
import { RefundsModule } from './refunds/refunds.module';
import { WalletModule } from './wallet/wallet.module';
import { ReportsModule } from './reports/reports.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { TargetsModule } from './targets/targets.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AutomationModule } from './automation/automation.module';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, jwtConfig, redisConfig],
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
    }),
    LoggerModule.forRootAsync({
      useFactory: () => buildPinoOptions(),
    }),
    ThrottlerModule.forRoot({
      // Default per-IP throttle: matches the "API default 100 req/min"
      // requirement. Auth and admin overrides live on the controllers
      // themselves via @Throttle({ default: { limit, ttl } }). The
      // skipIf hook lets ops disable rate-limiting entirely in CI/smoke
      // runs by setting THROTTLE_DISABLED=true (production must NOT).
      throttlers: [
        {
          name: 'default',
          ttl: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
          limit: Number(process.env.THROTTLE_DEFAULT_LIMIT ?? 100),
        },
      ],
      skipIf: () => process.env.THROTTLE_DISABLED === 'true',
    }),
    ScheduleModule.forRoot(),
    CacheModule,
    QueueModule,
    HealthModule,
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
    TreatmentEntitlementsModule,
    ServiceEventsModule,
    UnitsModule,
    StockItemsModule,
    SuppliersModule,
    PurchaseReceiptsModule,
    WarehousesModule,
    StockLotsModule,
    StockMovementsModule,
    OpenedContainersModule,
    StockTransfersModule,
    ExpirySweepModule,
    BranchStockSalesModule,
    ServicesModule,
    WalletModule,
    CommissionsModule,
    RefundsModule,
    ReportsModule,
    DashboardModule,
    TargetsModule,
    AuditModule,
    NotificationsModule,
    AutomationModule,
    JobsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
