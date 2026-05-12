# Reverie Desk — Backend Services

This catalogue documents every NestJS service class. For each service: **Responsibility**, **Inputs**, **Outputs**, **Cross-module calls**, **Transaction boundaries**.

> Path is relative to `src/`. "Tx-aware" methods accept a `Prisma.TransactionClient` so callers can compose them inside their own transactions; they are exported via `…With(tx, …)` suffix conventions.

---

## Cross-Cutting

### `common/services/audit.service.ts` — `AuditService`

- **Responsibility**: Append-only audit trail.
- **Inputs**:
  - `record({ actorUserId, branchId, entityType, entityId, action, payload? })`
  - `recordWith(tx, payload)` — same shape, runs inside a caller-supplied tx.
- **Outputs**: `Promise<void>`. `record()` swallows exceptions (logs only) so audit unavailability never blocks business writes; `recordWith()` lets the parent tx fail fast.
- **Cross-module calls**: none — direct Prisma writes.
- **Tx boundary**: `record()` opens its own short tx. `recordWith()` participates in caller's tx.

### `cache/cache.service.ts` — `CacheService`

- **Responsibility**: Cache facade with Redis + in-memory fallback.
- **Inputs**: `wrap<T>(key, ttl, producer)`, `get<T>(key)`, `set(key, value, ttl)`, `del(key)`, `delByPrefix(prefix)`. TTL helpers: `defaultTtl()`, `dashboardTtl()`, `reportTtl()`.
- **Outputs**: cache-or-compute results.
- **Cross-module calls**: none.
- **Tx boundary**: not transactional.

### `queue/queue.service.ts` — `QueueService`

- **Responsibility**: BullMQ producer facade.
- **Inputs**: `enqueueNotification(data)`, `enqueueAutomation(data)`, `enqueueReport(data)`. Optional `JobsOptions` overrides.
- **Outputs**: `Promise<Job | null>` (null when queues disabled).
- **Cross-module calls**: none directly; consumers are `workers.ts`.
- **Tx boundary**: producers run after the parent tx commits to avoid enqueuing for rolled-back work.

---

## Auth & Identity

### `auth/auth.service.ts` — `AuthService`

- **Responsibility**: Login + profile lookup.
- **Inputs**:
  - `login({ email, password })`
  - `getProfile(user)`
- **Outputs**:
  - `login` → `{ accessToken, user: { id, email, fullName, roles[] } }`
  - `getProfile` → `User` view (delegates to `UsersService.findOne`).
- **Cross-module calls**: `UsersService.findByEmailWithSecret`, `UsersService.findOne`, `JwtService.signAsync`.
- **Tx boundary**: read-only; no tx.

### `auth/strategies/jwt.strategy.ts` — `JwtStrategy.validate`

- **Responsibility**: Re-validate JWT subject on every request and inflate `AuthenticatedUser`.
- **Inputs**: JWT payload `{ sub, email, branchId? }`.
- **Outputs**: `AuthenticatedUser = { id, email, branchId: string | null, roles: RoleCode[], permissions: string[] }`.
- **Cross-module calls**: `UsersService.findOne`, `UsersService.getRoleCodes`, `UsersService.getPermissionCodes`.
- **Tx boundary**: read-only.

### `users/users.service.ts` — `UsersService`

- **Responsibility**: User CRUD, branch assignment, role/permission resolution, password hashing.
- **Inputs**:
  - `create(dto, actor)` (validates branch, enforces unique email, hashes password)
  - `findAll(actor)` / `findOne(id, actor?)` / `findByBranch(branchId, actor)`
  - `update(id, dto, actor)`
  - `assignBranch({ id, branchId }, actor)` / `unassignBranch(id, actor)`
  - Internal: `findByEmailWithSecret`, `getRoleCodes(userId)`, `getPermissionCodes(userId)`.
- **Outputs**: `User` view objects (sans `passwordHash`).
- **Cross-module calls**: `bcrypt.hash`, `branches.validateBranchActive` for `branchId`.
- **Tx boundary**: tx for create + role assignment; otherwise direct queries.

---

## Org & CRM

### `branches/branches.service.ts` — `BranchesService`

- **Responsibility**: Branch CRUD; (de)activation safety; helpers consumed by other modules.
- **Inputs**: `create(dto, actor)`, `findAll`, `findOne(id)`, `update(id, dto, actor)`, `activate(id, actor)`, `deactivate(id, actor)`. Helper: `validateBranchActive(branchId)` (throws if missing or inactive).
- **Outputs**: `Branch` views.
- **Cross-module calls**: none.
- **Tx boundary**: each mutation runs in its own tx (write + audit).

### `customer/customer.service.ts` — `CustomerService`

- **Responsibility**: Customer CRUD; soft delete; branch reassignment; concurrency-safe code generation (exposed for leads).
- **Inputs**: `create(dto, actor)`, `findAll(actor, query)`, `findOne(id, actor?)`, `update(id, dto, actor)`, `softDelete(id, actor)`, `changeBranch({id, currentBranchId}, actor)`. Helper: `findByPhoneOrEmail({phone?, email?})` and exported `generateMonthlyCode(tx, prefix, lockKey)`.
- **Outputs**: `Customer` views (filters `deletedAt != null`).
- **Cross-module calls**: `branches.validateBranchActive`.
- **Tx boundary**: create runs inside `prisma.$transaction` (advisory lock + insert + audit). Update/delete: each its own tx.

### `leads/leads.service.ts` — `LeadsService`

- **Responsibility**: Lead pipeline incl. owner reassignment with `LeadOwnerLog` and conversion to customer.
- **Inputs**: `create(dto, actor)`, `findAll(actor, query)`, `findOne(id, actor)`, `assignOwner({ id, ownerUserId }, actor)`, `updateStatus({ id, status, reason? }, actor)`, `convert({ id, phone?, email? }, actor)`.
- **Outputs**: `Lead` view objects.
- **Cross-module calls**: `branches.validateBranchActive`; `customer.generateMonthlyCode` and `customer.findByPhoneOrEmail` during `convert`.
- **Tx boundary**: `convert` runs inside `prisma.$transaction` (advisory lock + customer create or reuse + lead update + owner log close + audit). Other mutations use small txs.

---

## Sales / Money

### `sales-orders/sales-orders.service.ts` — `SalesOrdersService`

- **Responsibility**: Sales-order CRUD + status transitions for service sales.
- **Inputs**:
  - `create(dto, actor)` (validates branch, customer, lead, items)
  - `findAll(actor, query)` / `findOne(id, actor)`
  - `update(id, dto, actor)` (DRAFT only)
  - `confirm(id, actor)`
  - `cancel({ id, reason? }, actor)`
- **Outputs**: `SalesOrder` views with item snapshots and totals.
- **Cross-module calls**: `branches.validateBranchActive`. The deposit-satisfied trigger is fired by `payments.create`, not here.
- **Tx boundary**: `create`, `update`, `confirm`, `cancel` each open their own `prisma.$transaction` (write + audit, advisory lock for `SO-YYYYMM-####`).

### `payments/payments.service.ts` — `PaymentsService`

- **Responsibility**: Apply payments to a sales order, advance status, side-effect into wallet/commissions/entitlements/notifications.
- **Inputs**: `create(dto, actor)`, `findAll(actor, query)`, `findOne(id, actor)`.
- **Outputs**: `Payment` view + side-effect summary.
- **Cross-module calls** (inside one tx): `wallet.creditWith(tx, …)` (DEPOSIT type), `commissions.evaluateOrderWith(tx, …)` (deposit-satisfied), `entitlements.createForPaidOrderWith(tx, …)` (first PAID).
- **Cross-module calls (post-commit)**: `notifications.notifyMany` (deposit-satisfied), `commissions.notifyEligibleForOrder`.
- **Tx boundary**: a single `prisma.$transaction` covering payment insert, order update, wallet credit, commission evaluation, entitlement minting, and audit. Notifications enqueued/dispatched **after** commit.

### `wallet/wallet.service.ts` — `WalletService`

- **Responsibility**: Per-customer wallet balances.
- **Inputs**:
  - `findByCustomer(customerId, actor)`
  - `credit(dto, actor)` / `debit(dto, actor)` / `transfer(dto, actor)`
  - Tx-aware: `creditWith(tx, args, actor)`, `debitWith(tx, args, actor)`.
- **Outputs**: `Wallet` view + `WalletTransaction` row(s) with `balanceBefore`/`balanceAfter`.
- **Cross-module calls**: `customer.findOne` (existence check).
- **Tx boundary**: top-level `credit`/`debit`/`transfer` open their own `prisma.$transaction` with `pg_advisory_xact_lock(hashtext('wallet:' + customerId + ':' + walletType))`. Tx-aware methods join the caller's tx.

### `commissions/commissions.service.ts` — `CommissionsService`

- **Responsibility**: Commission engine.
- **Inputs**:
  - `evaluateOrder(salesOrderId, actor)` — wraps `evaluateOrderWith` in its own tx.
  - `evaluateOrderWith(tx, salesOrderId, actorUserId)` — tx-aware.
  - `findAll(actor, query)`, `findOne(id, actor)`
  - `lock(id, actor)` (`ELIGIBLE → LOCKED`)
  - `pay(id, actor)` (`LOCKED → PAID`, sends notification)
  - `revokeForOrderWith(tx, salesOrderId, refundId, reason)` (used by refunds)
  - `notifyEligibleForOrder(salesOrderId)` (post-commit fan-out)
- **Outputs**: `Commission` rows + `CommissionSnapshot` rows.
- **Cross-module calls**: `notifications.notifyMany` (eligibility + paid).
- **Tx boundary**: `evaluateOrderWith`, `revokeForOrderWith` are tx-aware. `lock`/`pay` open their own tx. Notifications dispatched after commit.

### `commissions/commission-rules.service.ts` — `CommissionRulesService`

- **Responsibility**: Admin / back-office CRUD on `CommissionRule` plus `bulkUpsert` (atomic ladder replacement) and `calculateForOrder` preview.
- **Inputs**: `findAll(query)`, `create(dto, actor)`, `update(id, dto, actor)`, `softDelete(id, actor)`, `bulkUpsert(dto, actor)`, `calculateForOrder(salesOrderId)`.
- **Outputs**: `CommissionRule` rows / preview payload.
- **Cross-module calls**: none. Helper `pickHighestMatchingTier(rules, orderAmount)` is exported and reused by `commissions.service.ts`.
- **Tx boundary**: `bulkUpsert` runs inside one tx (delete+insert per `(branchId, serviceGroupCode, commissionType)` bundle). Other mutations use a small tx.

### `refunds/refunds.service.ts` — `RefundsService`

- **Responsibility**: Refund lifecycle and money-flow side effects.
- **Inputs**: `create(dto, actor)`, `findAll(actor, query)`, `findOne(id, actor)`, `approve(id, actor)`, `reject(id, dto?, actor)`, `complete(id, actor)`.
- **Outputs**: `Refund` views.
- **Cross-module calls** (inside `complete` tx): `commissions.revokeForOrderWith(tx, …)`, `wallet.creditWith(tx, …)` when `creditToWallet=true`.
- **Cross-module calls (post-commit)**: `notifications.notifyMany` (`REFUND_REQUEST` on create/complete).
- **Tx boundary**: `create` (advisory lock + insert + audit) and `complete` (revoke + wallet credit + status update + audit) are wrapped in `prisma.$transaction`. Notifications dispatched after commit.

---

## Clinical

### `appointments/appointments.service.ts` — `AppointmentsService`

- **Responsibility**: Appointment lifecycle.
- **Inputs**: `create(dto, actor)`, `findAll(actor, query)`, `findOne(id, actor)`, `checkIn(id, actor)`, `complete(id, actor)`, `cancel({ id, reason? }, actor)`, `reschedule({ id, scheduledAt }, actor)`.
- **Outputs**: `Appointment` views with relations.
- **Cross-module calls**: `entitlements.assertBookable(tx, …)` (during create), `entitlements.tryConsumeAppointmentWith(tx, …)` (during complete with linked entitlement). `notifications.notifyMany` (post-commit).
- **Tx boundary**: each mutation in its own `prisma.$transaction`. `create` advisory-locks `appointment-no:${YYYYMMDD}`. `complete` validates events + (optionally) consumes entitlement atomically.

### `service-events/service-events.service.ts` — `ServiceEventsService`

- **Responsibility**: Clinical service event creation, stock consumption, completion (with appointment auto-complete).
- **Inputs**: `create(dto, actor)`, `findAll(actor, query)`, `findByCustomer(customerId, actor)`, `findOne(id, actor)`, `consumeStock(eventId, dto, actor)`, `complete(id, dto, actor)`.
- **Outputs**: `CustomerServiceEvent` view.
- **Cross-module calls**: direct writes against `StockLot`, `OpenedContainer` (when `openedContainerId` provided), `StockMovement`, `ServiceStockUsage`. Auto-completes the parent `Appointment` when all events are `COMPLETED`.
- **Tx boundary**: `consumeStock` and `complete` open their own tx and use `SELECT … FOR UPDATE` on the impacted lot or container.

### `treatment-entitlements/treatment-entitlements.service.ts` — `TreatmentEntitlementsService`

- **Responsibility**: Manage program entitlements (sessions remaining).
- **Inputs**:
  - Public: `listForCustomer(customerId, actor)`, `findOne(id, actor)`, `consumeForAppointment({ appointmentId, actor })`, `expire(id, dto, actor)`.
  - Internal (tx-aware): `createForPaidOrderWith(tx, salesOrderId, actorUserId)`, `assertBookable(tx, entitlementId, customerId, serviceId)`, `tryConsumeAppointmentWith(tx, entitlementId, appointmentId)`.
- **Outputs**: `TreatmentEntitlement` views with derived `remainingSessions`, `isExpired`.
- **Cross-module calls**: none — all logic is local Prisma + raw SQL guards.
- **Tx boundary**: every mutation is tx-aware; `tryConsumeAppointmentWith` uses two atomic guards (appointment stamp + raw `UPDATE` on `consumedSessions`) to make session drawdown idempotent and race-safe.

---

## Inventory

### `inventory/units/units.service.ts` — `UnitsService`

- **Responsibility**: Unit CRUD.
- **Inputs**: `create`, `findAll`, `findOne`, `update`, `softDelete`.
- **Outputs**: `Unit` views.
- **Cross-module calls**: none.
- **Tx boundary**: per-mutation tx + audit.

### `inventory/suppliers/suppliers.service.ts` — `SuppliersService`

- Same shape as `UnitsService` but no delete (referenced by stock lots / receipts).

### `inventory/stock-items/stock-items.service.ts` — `StockItemsService`

- **Responsibility**: Stock item CRUD with cross-field validation (`secondaryUnitId` requires `conversionFactor`).
- **Inputs**: `create`, `findAll`, `findOne`, `update`, `softDelete`.
- **Outputs**: `StockItem` views.
- **Cross-module calls**: validates `Unit` IDs.
- **Tx boundary**: per-mutation tx + audit.

### `inventory/purchase-receipts/purchase-receipts.service.ts` — `PurchaseReceiptsService`

- **Responsibility**: Header-level purchase receipts (referenced by stock lots).
- **Inputs**: `create`, `findAll`, `findOne`.
- **Outputs**: `PurchaseReceipt` views.
- **Cross-module calls**: validates supplier id.
- **Tx boundary**: per-mutation tx + audit.

### `inventory/stock-lots/stock-lots.service.ts` — `StockLotsService`

- **Responsibility**: Stock receiving and lot listing (FEFO default).
- **Inputs**: `receive(dto, actor)`, `findAll(actor, query)`, `findExpiring({ days }, actor)`, `findOne(id, actor)`.
- **Outputs**: `StockLot` views (with item / warehouse relations).
- **Cross-module calls**: validates stock item, warehouse, supplier, receipt.
- **Tx boundary**: `receive` runs in `prisma.$transaction` (lot insert + `PURCHASE_IN` movement + audit).

### `inventory/stock-transfers/stock-transfers.service.ts` — `StockTransfersService`

- **Responsibility**: Stock transfer between warehouses with state machine and ledger correctness.
- **Inputs**: `create`, `findAll`, `findOne`, `request`, `approve`, `dispatch`, `receive`, `cancel`.
- **Outputs**: `StockTransfer` views.
- **Cross-module calls**: post-commit `notifications.notifyMany` on `receive`. Helper `RecipientsService.branchManagers/centralStockHub` for recipients.
- **Tx boundary**:
  - `dispatch`: `prisma.$transaction` with `SELECT id … FOR UPDATE` on every source lot, decrement, write `TRANSFER_OUT`.
  - `receive`: `prisma.$transaction` to mint destination lots (unique-ified codes), write `TRANSFER_IN`, stamp items.
  - Other transitions: small tx + audit.

### `inventory/opened-containers/opened-containers.service.ts` — `OpenedContainersService`

- **Responsibility**: Multi-use containers (open / use / discard / expire).
- **Inputs**: `open`, `use`, `discard`, `expire`, `findAll`, `findOne`.
- **Outputs**: `OpenedContainer` views.
- **Cross-module calls**: validates linked `CustomerServiceEvent` on `use`.
- **Tx boundary**: each mutation in its own `prisma.$transaction` with `SELECT … FOR UPDATE` on the source lot (`open`) or container (`use`).

### `inventory/expiry-sweep/expiry-sweep.service.ts` — `ExpirySweepService`

- **Responsibility**: Auto-expire past-due lots and opened containers.
- **Inputs**: `runScheduled()` (cron, daily 03:00), `runManual(actor)` (admin endpoint).
- **Outputs**: counts of items expired.
- **Cross-module calls**: none beyond audit.
- **Tx boundary**: each row updated in its own short tx (re-check + lock + status flip + ledger move + audit) so partial failures don't roll back the whole sweep.

---

## Branch Stock Sales

### `sales/branch-stock-sales/branch-stock-sales.service.ts` — `BranchStockSalesService`

- **Responsibility**: Walk-in retail sale of stock items at a branch.
- **Inputs**: `create`, `findAll`, `findOne`, `pay`, `complete`, `cancel`, `requestRefund`, `approveRefund`.
- **Outputs**: `BranchStockSale` views with item snapshots.
- **Cross-module calls**: stock allocation against `StockLot` (FEFO at create; locked decrement at complete).
- **Tx boundary**: `create`, `complete`, refund ops each open `prisma.$transaction` and use `SELECT … FOR UPDATE` on impacted lots.

---

## Targets

### `targets/targets.service.ts` — `TargetsService`

- **Responsibility**: CRUD on `BranchQuarterTarget` and its category breakdown.
- **Inputs**: `create(dto, actor)`, `update(id, dto, actor)`, `findForQuarter({ branchId, year, quarter }, actor)`, `findOne(id, actor)`.
- **Outputs**: `BranchQuarterTarget` views.
- **Cross-module calls**: validates branch active; uses `assertCategorySumMatchesTotal` helper from `quarter.util.ts`.
- **Tx boundary**: `create` and `update` run inside `prisma.$transaction` (replace categories atomically). Maps `P2002` on `(branchId, year, quarter)` → `409 Conflict`.

### `targets/target-progress.service.ts` — `TargetProgressService`

- **Responsibility**: Read-only progress calculation for a quarter.
- **Inputs**: `getQuarterProgress(actor, branchId, year, quarter)`. Helpers `calculateCategoryProgress`, `calculateOverallProgress`.
- **Outputs**: `{ branch, year, quarter, totalTarget, totalActual, overallProgress, categories[] }`.
- **Cross-module calls**: raw SQL aggregate on `sales_order_items + sales_orders + services` for completed orders in `[start, end)`.
- **Tx boundary**: read-only.

---

## Reports / Dashboard / Audit

### `reports/reports.service.ts` — `ReportsService`

- **Responsibility**: Aggregated read-only views.
- **Inputs**: `sales`, `payments`, `serviceEvents`, `appointments`, `inventory`, `commissions`, `wallets`, `refunds`, `targets`. Each takes a typed `*-report-query.dto.ts`.
- **Outputs**: aggregation payloads (totals + breakdowns).
- **Cross-module calls**: `TargetProgressService.getQuarterProgress` for target reporting; otherwise direct Prisma `aggregate`/`groupBy`/`$queryRawUnsafe`.
- **Tx boundary**: read-only.

### `dashboard/dashboard.service.ts` — `DashboardService`

- **Responsibility**: KPI cards for executive / branch / doctor / telesales dashboards.
- **Inputs**: `getExecutive(actor)`, `getBranch(actor, branchId)`, `getDoctor(actor, userId)`, `getTelesales(actor, userId)`.
- **Outputs**: card payloads, e.g. `{ todaySales, monthSales, outstandingDeposits, totalAppointmentsToday, stockAlerts, pendingRefunds, pendingCommissions }`.
- **Cross-module calls**: `cache.wrap(key, dashboardTtl(), …)` for per-card caching.
- **Tx boundary**: read-only.

### `audit/audit.service.ts` — `AuditQueryService`

- **Responsibility**: Read access to `audit_logs`.
- **Inputs**: `search(actor, query)`, `summary(actor, query)`, `entityTimeline(actor, entityType, entityId, query)`, `userActivity(actor, userId, query)`.
- **Outputs**: paginated `AuditLog` rows plus summary buckets (`byAction`, `byEntity`, recent events).
- **Cross-module calls**: none.
- **Tx boundary**: read-only.

---

## Notifications, Automation & Settings

### `notifications/notifications.service.ts` — `NotificationsService`

- **Responsibility**: Persist + deliver in-system notifications; idempotent dedup.
- **Inputs**:
  - `notify(input)` — single notification.
  - `notifyMany(userIds, base)` — fan-out.
  - `dispatch(notification)` — invoke channel registry.
  - `dispatchById(id)` — used by BullMQ worker.
  - `list(actor, query)`, `summary(actor, query)`, `unreadCount(actor)`, `markRead(id, actor)`, `markAllRead(actor)`, `create(dto, actor)`.
- **Outputs**: `{ created: boolean; notification: Notification }` (idempotent on `dedupeKey`).
- **Cross-module calls**: `NotificationProviderRegistry.dispatch` → providers `InAppNotificationProvider`, `EmailNotificationProvider` (stub), `SmsNotificationProvider` (stub).
- **Tx boundary**: writes are short single-row inserts; not part of the parent business tx (always invoked post-commit by callers).

### `automation/automation.service.ts` — `AutomationService`

- **Responsibility**: Registry + dispatcher for automation rules.
- **Inputs**: `list()`, `listRuns(query)`, `setEnabled(actor, code, enabled)`, `run(code, actor?)`, `runScheduled(code)` (respects disabled flag).
- **Outputs**: rule registry rows plus persisted `automation_run_logs` entries and `AutomationRuleResult`.
- **Cross-module calls**: each `AutomationRule.execute()` queries Prisma read-side and calls `notifications.notifyMany`; writes audit rows when admins toggle or manually run rules.
- **Tx boundary**: runtime state and run-log persistence use Prisma writes before/after each rule execution.

### `settings/settings.service.ts` — `SettingsService`

- **Responsibility**: Persist and merge org-wide settings with sensible defaults.
- **Inputs**: `getAll()`, `update(actor, dto)`.
- **Outputs**: `SettingsPayload` with `general`, `finance`, `inventory`, `notifications`, and `automation` sections.
- **Cross-module calls**: validates `general.defaultBranchId` via `BranchesService`; writes audit entries for admin changes.
- **Tx boundary**: `update` runs inside a Prisma transaction so setting persistence and audit logging stay in sync.

### `automation/recipients.service.ts` — `RecipientsService`

- **Responsibility**: Resolve user IDs by role + branch for fan-out.
- **Inputs**: `usersByRoles(codes, branchId?)`, `branchManagers(branchId)`, `centralStockHub()`.
- **Outputs**: `string[]` user IDs (active users only).
- **Cross-module calls**: direct Prisma queries on `User` + `UserRole` + `Role`.
- **Tx boundary**: read-only.

### `automation/rules/*.rule.ts` — `AutomationRule` implementations

Each rule implements:

```ts
interface AutomationRule {
  readonly code: string;
  readonly description: string;
  readonly schedule: string; // cron expression
  execute(): Promise<AutomationRuleResult>;
}
```

| Rule class | Code | Side effects |
|---|---|---|
| `DepositPendingRule` | `DEPOSIT_PENDING` | Notify sales creator + branch managers about unpaid deposits |
| `AppointmentReminderRule` | `APPOINTMENT_REMINDER` | Notify doctor + creator |
| `LowStockRule` | `LOW_STOCK` | Notify managers + central hub |
| `ExpiringStockRule` | `EXPIRING_STOCK` | Notify managers + central hub |
| `RefundApprovalRule` | `REFUND_APPROVAL` | Notify approvers |
| `CommissionEligibleRule` | `COMMISSION_ELIGIBLE` | Notify recipients |
| `WalletExpiryRule` | `WALLET_EXPIRY` | Notify branch managers |
| `LeadFollowupRule` | `LEAD_FOLLOWUP` | Notify lead owner |

---

## Jobs / Health

### `jobs/scheduler.service.ts` — `SchedulerService`

- **Responsibility**: `@nestjs/schedule` cron registry. One method per rule (hardcoded for clarity), each delegating to `AutomationService.runScheduled(code)`.
- **Inputs**: cron runtime triggers.
- **Outputs**: void (rule results logged).
- **Cross-module calls**: `AutomationService`.
- **Tx boundary**: not transactional.

### `health/health.controller.ts` — uses `@nestjs/terminus`

- **Responsibility**: Liveness + readiness probes (`SELECT 1` on Prisma, `client.ping()` on Redis when configured).

---

## Notes on Tx-Aware Helpers

The following methods are explicitly designed to be called **inside a parent transaction**:

- `wallet.creditWith(tx, …)`, `wallet.debitWith(tx, …)`
- `commissions.evaluateOrderWith(tx, …)`, `commissions.revokeForOrderWith(tx, …)`
- `entitlements.createForPaidOrderWith(tx, …)`, `entitlements.assertBookable(tx, …)`, `entitlements.tryConsumeAppointmentWith(tx, …)`
- `audit.recordWith(tx, …)`

Top-level methods (`credit`, `debit`, `evaluateOrder`, etc.) wrap their `*With` counterparts in a fresh `prisma.$transaction` for direct API callers. This dual-path pattern keeps the public API ergonomic while enabling correct atomicity when payments / refunds compose multiple side effects.
