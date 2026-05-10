# Reverie Desk — Domain Glossary

Authoritative terminology reference for the Reverie Desk clinic ERP. Every term documented here exists in the current Prisma schema (`prisma/schema.prisma`), in a NestJS service under `src/`, or in business logic enforced by both. This file is the **primary AI context reference**: prefer wording from this glossary when describing system behavior.

For each term:

- **Definition** — concise meaning in the system.
- **Related entities** — Prisma models that participate.
- **Lifecycle** — how the term comes into being and how it ends (where applicable).
- **Business rules** — invariants, validations, and side effects.
- **Example** — a concrete case you can map to behavior.

---

## Section 1 — Foundational / Cross-cutting Concepts

### Branch Scope

- **Definition**: The mechanism that limits a user's data visibility to a single `Branch`. Implemented in `src/common/authz/branch-scope.ts`.
- **Related entities**: `User`, `UserRole`, `Branch`, every entity carrying `branchId`.
- **Lifecycle**: enforced on every request after `JwtStrategy.validate` populates `AuthenticatedUser.branchId`.
- **Business rules**:
  - `ADMIN` and `SUPER_BRANCH_MANAGER` are **unrestricted** (set: `UNRESTRICTED_ROLES`); they see all branches.
  - All other roles are constrained to `user.branchId`.
  - `assertBranchAccess(user, targetBranchId)` throws `ForbiddenException` if a scoped user accesses a branch other than their own.
  - `scopedBranchFilter(user)` returns `undefined` for unrestricted users, `user.branchId` for scoped users, and the sentinel `'__none__'` if a scoped user's `branchId` is `null` (which yields empty result sets instead of leaking system-wide data).
- **Example**: a `BRANCH_MANAGER` of HQ querying `GET /sales-orders?branchId=Bangkok` gets either an empty list (read paths) or `403 FORBIDDEN` (mutation paths).

### Soft Delete

- **Definition**: Marking a row as deleted via a `deletedAt` timestamp instead of removing it.
- **Related entities**: `Customer`, `Service`, `StockItem`, `Lead` (where applicable), `CommissionRule` (uses `isActive=false` rather than `deletedAt`).
- **Lifecycle**: `deletedAt = now()` flag set on `DELETE /…/:id`; subsequent listings filter the row out.
- **Business rules**:
  - Uniqueness checks (e.g. `Customer.phone`) ignore soft-deleted rows.
  - Soft-deleted rows can still be referenced as foreign keys (audit trail integrity).
- **Example**: deleting a customer prevents them appearing in lists but keeps their sales orders / payments / wallets intact.

### Audit Logging

- **Definition**: Append-only record of state-changing operations. Service: `AuditService` (`src/common/services/audit.service.ts`); read API: `AuditQueryService` (`src/audit/audit.service.ts`).
- **Related entities**: `AuditLog` (Prisma model), every domain entity (referenced by `entityType` + `entityId`).
- **Lifecycle**: `AuditService.record()` opens its own short tx; `recordWith(tx, …)` participates in caller's tx. Failures of the non-tx path are swallowed — audit unavailability never blocks business writes.
- **Business rules**:
  - Each row stores `actorUserId`, `branchId`, `entityType`, `entityId`, `action` (`AuditAction` enum), and a JSON `payload` snapshot.
  - Read access requires `AUDIT_VIEW` permission and is branch-scoped.
- **Example**: when `payments.create` runs, it records `Payment.create` and `SalesOrder.update` (status change) in the same tx.

### Snapshot

- **Definition**: A frozen copy of context fields stored on a transactional row so later edits to the source don't rewrite history.
- **Related entities**: `SalesOrderItem` (`snapshotServiceCode`, `snapshotServiceName`, `snapshotUnitPrice`), `BranchStockSaleItem` (`snapshotItemName`, `snapshotUnitLabel`, `snapshotUnitPrice`), `CommissionSnapshot` (frozen branch name, recipient role, sale creator name, lead-owner name, service name, tier rule + value).
- **Lifecycle**: created when the parent row is created; never mutated.
- **Business rules**:
  - Reports render snapshots, not live joins, when the source has changed.
  - `CommissionSnapshot` is the canonical truth for what the system thought when a commission was evaluated.
- **Example**: a service's `basePrice` rises from 5,000 to 6,000 THB; an order created at 5,000 still bills, refunds, and commissions at 5,000.

### Code Generation (Sequential Numbering)

- **Definition**: Concurrency-safe minting of human-readable monotonic identifiers using `pg_advisory_xact_lock(hashtext(<key>))` inside a Prisma transaction.
- **Related entities**: `Customer.code` (`CUST-YYYYMM-####`), `Lead.code` (`LEAD-YYYYMM-####`), `SalesOrder.orderNo` (`SO-YYYYMM-####`), `Appointment.appointmentNo` (`APT-YYYYMMDD-####`), `StockTransfer.transferNo` (`TR-YYYYMMDD-####`), `Refund.refundNo` (`RFD-YYYYMMDD-####`), `Wallet` (lock per `(customerId, walletType)`).
- **Lifecycle**: lock released on tx commit/rollback.
- **Business rules**:
  - Lock keys are namespaced strings (e.g. `'sales-order-no'`, `'appointment-no:20260508'`).
  - Two concurrent creators serialize through the lock and produce strictly increasing sequence numbers per scope (month or day).
- **Example**: two front-desk operators creating sales orders simultaneously yield `SO-202605-0001` and `SO-202605-0002`, never duplicates.

### FEFO (First-Expired, First-Out)

- **Definition**: Allocation strategy that consumes stock from the lot with the earliest `expiresAt` first (lots without an expiry come last).
- **Related entities**: `StockLot`, `BranchStockSaleItem` (FEFO at create), service-event consumption (FEFO via `findAll` ordering).
- **Lifecycle**: applied on read whenever a service "picks the next lot to consume from."
- **Business rules**: `orderBy: [{ expiresAt: 'asc', nulls: 'last' }, { receivedAt: 'asc' }]`.
- **Example**: two ACTIVE lots of Botox 50U, expiry 2026-09-01 and 2027-01-01. A clinical event consumes from the September lot first.

### Transaction Boundary (Tx-Aware Helpers)

- **Definition**: Service methods that accept a `Prisma.TransactionClient` so multiple cross-module writes can be atomic. Suffix convention: `*With(tx, …)`.
- **Related entities**: `WalletService.creditWith` / `debitWith`, `CommissionsService.evaluateOrderWith` / `revokeForOrderWith`, `TreatmentEntitlementsService.createForPaidOrderWith` / `assertBookable` / `tryConsumeAppointmentWith`, `AuditService.recordWith`.
- **Lifecycle**: lifetime equals the parent `prisma.$transaction` callback.
- **Business rules**:
  - Top-level public methods (`credit`, `evaluateOrder`, etc.) wrap their `*With` counterpart in a fresh tx.
  - Notification dispatch always happens **post-commit**, never inside the tx, to avoid notifying for rolled-back work.
- **Example**: `payments.create` runs `wallet.creditWith(tx, …)`, `commissions.evaluateOrderWith(tx, …)`, and `entitlements.createForPaidOrderWith(tx, …)` inside one transaction; if any throws, all roll back.

### Idempotency

- **Definition**: Property that repeating an operation yields the same end-state (and no duplicate side-effect rows).
- **Related entities**:
  - `Notification.dedupeKey @unique` — duplicate emit returns the existing row.
  - `TreatmentEntitlement.salesOrderItemId @unique` — re-running mint on a re-PAID order is a no-op.
  - `Appointment.entitlementConsumedAt` — second `complete()` call detects the timestamp and rejects.
  - `CommissionSnapshot @@unique([salesOrderId, serviceGroupCode, commissionType])` — rerunning `evaluateOrder` doesn't double-create.
- **Lifecycle**: enforced via DB unique constraints (Prisma error `P2002` is mapped to `409 CONFLICT` or short-circuited inline).
- **Business rules**: all event hooks must build a deterministic dedupe key (typically `<TYPE>|<entityId>|<userId or day>`).
- **Example**: a cron rule fires the same hour twice (network blip) — the second pass observes existing notifications keyed `LOW_STOCK|warehouseId|stockItemId|2026-05-08` and emits zero new rows.

### Dedupe Key

- **Definition**: A string discriminator stored on `Notification.dedupeKey` to make notification creation idempotent.
- **Related entities**: `Notification`.
- **Lifecycle**: built at notify time; persisted; uniqueness enforced.
- **Business rules**:
  - Format: typically `<TYPE>|<entityId>|<recipient>|<bucket>` where `bucket` is a day or hour string.
  - On `P2002`, `notify()` returns `{ created: false, notification }` — caller treats as success.
- **Example**: `APPOINTMENT_REMINDER|appt_123|YYYYMMDDHH` ensures the 30-minute reminder rule only emits once per hour bucket per appointment.

### Standard Response Envelope

- **Definition**: Consistent JSON shape for all REST responses.
- **Related**: `ResponseEnvelopeInterceptor`, `HttpExceptionFilter`.
- **Business rules**:
  - Success: `{ success: true, data: <payload> }`
  - Error: `{ success: false, error: { statusCode, code, message, details?, path, timestamp, correlationId } }`
- **Example**: `GET /branches/:id` returns `{ success: true, data: { id, code, name, status, ... } }`.

### Correlation ID

- **Definition**: Per-request UUID propagated via `x-request-id` header by `pino-http`. Surfaces in error envelopes and structured logs.
- **Related**: `LoggerModule` configuration in `src/app.module.ts`.
- **Business rules**: every error envelope includes `correlationId`. Frontends should display it for support tickets.
- **Example**: a 500 error returns `correlationId: "9b1d1b…"`; ops grep logs by that id to see the full request trail.

---

## Section 2 — Org & Identity

### Branch

- **Definition**: A clinic location.
- **Related entities**: `Branch`, `User`, `Customer`, `Lead`, `SalesOrder`, `Appointment`, `Warehouse`, `BranchStockSale`, `CommissionRule`, `BranchQuarterTarget`, `Notification`.
- **Lifecycle**: `POST /branches` → `ACTIVE` → optional `deactivate` → `INACTIVE`. Deactivation is blocked if the branch has active appointments or pending stock transfers.
- **Business rules**:
  - `code` is unique, auto-uppercased, `[A-Z0-9_-]+`, 2..20 chars.
  - Most domain operations call `BranchesService.validateBranchActive(branchId)` before writing.
- **Example**: HQ has `code: 'HQ'`, `name: 'Headquarters'`, `status: ACTIVE`.

### Warehouse

- **Definition**: Physical or logical stock-holding location, scoped by `WarehouseType`.
- **Related entities**: `Warehouse`, `Branch` (`branchId` for `BRANCH` type), `StockLot`, `OpenedContainer`, `StockTransfer`.
- **Lifecycle**: created via seed or admin (no public `/warehouses` controller in this audit). Active flag toggled administratively.
- **Business rules**:
  - `WarehouseType.CENTRAL_HUB` warehouses are not pinned to a branch.
  - `WarehouseType.BRANCH` warehouses must reference a `Branch`.
  - Branch retail (`BranchStockSale`) consumes only from BRANCH-type warehouses of that branch.
- **Example**: `CENTRAL` (CENTRAL_HUB) feeds `HQ-WH` (BRANCH, branchId=HQ) via stock transfers.

### User

- **Definition**: Authenticated actor in the system.
- **Related entities**: `User`, `UserRole`, `Role`, `Permission`, `Branch` (optional `branchId`).
- **Lifecycle**: `POST /users` (`UserStatus.ACTIVE` default) → optional `INACTIVE` / `SUSPENDED` via update.
- **Business rules**:
  - `email` unique, ≤180.
  - `password` validated by `class-validator` (8..72 chars + lower + upper + digit + special); hashed with `bcrypt` cost 12.
  - `branchId` is **nullable** (cross-branch roles can be unpinned).
  - Login requires `status === ACTIVE`.
- **Example**: a doctor user assigned to HQ branch with role `DOCTOR` has visibility only into HQ's appointments and service events.

### Role

- **Definition**: Named set of permissions; identified by `RoleCode` enum.
- **Related entities**: `Role`, `RolePermission`, `Permission`, `UserRole`.
- **Lifecycle**: created once via seed; not mutated at runtime.
- **Business rules**: `RoleCode` is fixed at the schema level: `ADMIN`, `TELESALES`, `CS`, `DOCTOR`, `EMPLOYEE`, `BRANCH_MANAGER`, `SUPER_BRANCH_MANAGER`, `CENTRAL_STOCK_HUB`.
- **Example**: `BRANCH_MANAGER` grants permissions `REPORT_VIEW`, `DASHBOARD_VIEW`, `AUDIT_VIEW`, `NOTIFICATION_VIEW`, `NOTIFICATION_MANAGE`.

### Permission

- **Definition**: Discrete capability gate enforced by `PermissionsGuard` and `@RequirePermission(...)`.
- **Related entities**: `Permission`, `RolePermission`, `Role`.
- **Lifecycle**: seeded once. New permissions require code + DB seed update.
- **Business rules**: defined in `src/common/authz/permission-codes.ts` as a const tuple; permissions = `REPORT_VIEW`, `DASHBOARD_VIEW`, `AUDIT_VIEW`, `NOTIFICATION_VIEW`, `NOTIFICATION_MANAGE`, `AUTOMATION_MANAGE`.
- **Example**: only roles granted `AUTOMATION_MANAGE` (ADMIN, SUPER_BRANCH_MANAGER) can hit `POST /automation/run/:code`.

### UserRole

- **Definition**: Association linking a user to a role, optionally scoped by branch.
- **Related entities**: `User`, `Role`, `Branch`.
- **Lifecycle**: created on user creation or via `assignBranch`; carries `branchId` when role is branch-scoped.
- **Business rules**: `UserRole.branchId` may differ from `User.branchId`; the user's effective `branchId` for scoping comes from `User.branchId`.
- **Example**: a user could hold `DOCTOR` at HQ via `UserRole(branchId=HQ)`.

### AuthenticatedUser

- **Definition**: Runtime projection of `User` + roles + permissions, attached to every request.
- **Related**: `JwtStrategy.validate`.
- **Business rules**: shape is `{ id, email, branchId: string | null, roles: RoleCode[], permissions: string[] }`.
- **Example**: services call `assertBranchAccess(user, branchId)` and `user.permissions.includes('REPORT_VIEW')`.

---

## Section 3 — CRM

### Lead

- **Definition**: Pre-sale prospect being nurtured by telesales / CS.
- **Related entities**: `Lead`, `LeadOwnerLog`, `Branch`, `Customer` (after conversion), `User` (`currentOwnerUserId`).
- **Lifecycle**: `LeadStatus = NEW → CONTACTED → QUALIFIED → WON|LOST|ARCHIVED`. `WON` only via `convert()`.
- **Business rules**:
  - `branchId` required at creation.
  - Status updates validate transition legality; `ASSIGNED` events open + close `LeadOwnerLog` rows.
  - Telesales without ownership cannot touch a lead unless reassigned.
- **Example**: a Facebook ad inquiry creates a `Lead` (`status=NEW`); after a phone call → `CONTACTED`; after appointment booked → `WON` via convert.

### LeadOwnerLog

- **Definition**: Audit-friendly history of who owned a lead and when.
- **Related entities**: `Lead`, `User`.
- **Lifecycle**: row created on every owner change; `endedAt` stamped when ownership rolls over.
- **Business rules**: at most one row per lead has `endedAt = null`.
- **Example**: lead owned by `tele1` from May 1 to May 5, then `tele2` from May 5 onwards.

### Customer

- **Definition**: Identified person who has either purchased or been registered for purchase.
- **Related entities**: `Customer`, `Wallet`, `SalesOrder`, `Appointment`, `CustomerServiceEvent`, `TreatmentEntitlement`, `Branch` (current).
- **Lifecycle**: created via `POST /customers` or `leads.convert`; soft-deleted via `DELETE /customers/:id`.
- **Business rules**:
  - `phone` (Thai format) and `email` unique among non-deleted customers.
  - Concurrency-safe code `CUST-YYYYMM-####`.
  - `currentBranchId` may be reassigned; target branch must be `ACTIVE`.
  - Soft delete sets `deletedAt`; uniqueness checks ignore deleted rows.
- **Example**: a converted lead becomes `CUST-202605-0001`, current branch HQ.

### Sales Channel

- **Definition**: Source/categorization for branch retail sales.
- **Related entities**: `SalesChannel`, `BranchStockSale`.
- **Lifecycle**: seeded once; identified by `SalesChannelCode` enum.
- **Business rules**: codes are fixed: `WALK_IN`, `DELIVERY`, `STAFF`, `EXECUTIVE`, `VIP`, `PRESENTER`.
- **Example**: a walk-in customer's branch stock sale has `salesChannelId` referencing `WALK_IN`.

---

## Section 4 — Catalog

### Service

- **Definition**: A clinical procedure that customers buy (e.g. "Hair Growth Program 7 sessions").
- **Related entities**: `Service`, `SalesOrderItem`, `Appointment`, `CustomerServiceEvent`, `TreatmentEntitlement`.
- **Lifecycle**: created via seed/admin (no public CRUD controller in this audit); deactivated via `isActive=false` or `deletedAt`.
- **Business rules**:
  - Belongs to a **branch** (`branchId`) — services are not shared across branches.
  - `commissionGroupCode` must point to a `ServiceGroupCode` value for any service that should generate commissions.
  - `isProgram=true` services require `defaultSessions` to be set; minting `TreatmentEntitlement` rows depends on this.
- **Example**: "Hair Growth Program" — `commissionGroupCode=RATE_HAIR`, `isProgram=true`, `defaultSessions=7`, `basePrice=15000`.

### Service Group / Commission Group

- **Definition**: Coarse grouping of services used to apply tiered commission rules. Backed by the `ServiceGroupCode` enum.
- **Related entities**: `Service.commissionGroupCode`, `CommissionRule.serviceGroupCode`, `CommissionSnapshot`, `BranchQuarterTargetCategory.commissionGroup`.
- **Lifecycle**: enum is fixed in schema; adding a group is a schema migration.
- **Business rules**: every commissionable service must declare its group; the group drives both commission calculation and quarterly target buckets.
- **Example**: `RATE_HAIR` covers all hair-related programs; `RATE_SURGERY` covers surgical procedures.

### Stock Item

- **Definition**: SKU representing a physical inventory unit (consumable, retail product, etc.).
- **Related entities**: `StockItem`, `Unit` (primary + optional secondary), `StockLot`, `OpenedContainer`, `BranchStockSaleItem`, `ServiceStockUsage`.
- **Lifecycle**: created via `POST /stock-items`; soft-deleted via `deletedAt`.
- **Business rules**:
  - `sku` `[A-Za-z0-9_-]+`, auto-uppercased, 1..64.
  - `consumptionStrategy` ∈ `{WHOLE_ONLY, PARTIAL_ALLOWED, PARTIAL_REQUIRED}` controls whether opened containers are required.
  - `secondaryUnitId` requires `conversionFactor > 0` (cross-field check in service).
  - `isSellable=true` to appear in retail sales; `trackLot=true` to require lot tracking.
- **Example**: "Botox 50U" — primary unit `VIAL`, secondary unit `UNIT`, `conversionFactor=50`, `consumptionStrategy=PARTIAL_REQUIRED`.

### Unit

- **Definition**: Unit of measure (bottle, vial, gram, ml, etc.).
- **Related entities**: `Unit`, `StockItem.primaryUnitId`, `StockItem.secondaryUnitId`.
- **Lifecycle**: CRUD via `/units`.
- **Business rules**: `code` is unique; `isActive` controls visibility.
- **Example**: `VIAL` and `UNIT` both exist; Botox uses VIAL as primary, UNIT as secondary.

### Supplier

- **Definition**: Vendor referenced on purchase receipts and stock lots.
- **Related entities**: `Supplier`, `PurchaseReceipt`, `StockLot`.
- **Lifecycle**: CRUD via `/suppliers` (no delete).
- **Business rules**: `code` unique; `isActive` controls visibility.
- **Example**: "Allergan" supplies Botox lots.

### Purchase Receipt

- **Definition**: Header record for a procurement event (one supplier, one branch, optional reference number).
- **Related entities**: `PurchaseReceipt`, `Supplier`, `Branch`, `StockLot`.
- **Lifecycle**: created via `POST /purchase-receipts`; immutable.
- **Business rules**: typically created before receiving lots; `StockLot.purchaseReceiptId` links physical inventory to the paperwork.
- **Example**: PR-202605-001 for "Allergan invoice INV-2026-A".

---

## Section 5 — Sales (Service Sales)

### Sales Order

- **Definition**: Header record for a service-sale transaction; the canonical money trigger for clinical operations.
- **Related entities**: `SalesOrder`, `SalesOrderItem`, `Customer`, `Branch`, `Lead?`, `Payment`, `Appointment`, `CustomerServiceEvent`, `TreatmentEntitlement`, `Refund`, `CommissionSnapshot`, `Commission`.
- **Lifecycle**: `SalesOrderStatus = DRAFT → CONFIRMED → {PARTIALLY_PAID, PAID} → COMPLETED|REFUNDED`; `CANCELLED` reachable from `DRAFT`/`CONFIRMED`.
- **Business rules**:
  - `orderNo` minted via `pg_advisory_xact_lock` as `SO-YYYYMM-####`.
  - At least one item required; `Service` must be active and on the order's branch.
  - `depositRequired ≤ totalAmount`.
  - `confirm()` rejects empty orders.
  - Status transitions to `PARTIALLY_PAID`/`PAID`/`REFUNDED` are owned by `payments.create` / `refunds.complete`, not `sales-orders` itself.
- **Example**: order `SO-202605-0001` for customer A, branch HQ, total 15,000 THB, deposit 1,500.

### Sales Order Item

- **Definition**: Line item on a sales order with a snapshotted service identity and pricing.
- **Related entities**: `SalesOrderItem`, `Service`, `TreatmentEntitlement` (1:1 when service is a program).
- **Lifecycle**: created with order; replaced atomically on `PATCH` while the order is `DRAFT`.
- **Business rules**:
  - Snapshots `serviceCode/Name/UnitPrice` so later changes to `Service` don't rewrite history.
  - `quantity ≥ 1`; `unitPrice` defaults to `service.basePrice`; per-line `discountAmount`.
  - `netAmount` (Decimal) is the post-discount line total used by commission and target calculations.
- **Example**: 1 × Hair Growth Program @ 15,000 THB, discount 0 → netAmount 15,000.

### Payment

- **Definition**: A money-in event applied to a sales order.
- **Related entities**: `Payment`, `SalesOrder`, `Wallet` (when `paymentType=DEPOSIT`), `Commission` (via evaluation), `TreatmentEntitlement` (mint on first PAID).
- **Lifecycle**: `PaymentStatus.SUCCESS` is the synchronous default; failures throw and roll back. `PENDING/FAILED/VOIDED/REFUNDED` exist in the enum but the controller path always issues `SUCCESS`.
- **Business rules**:
  - `amount > 0` (≤2dp); cumulative successful payments cannot exceed `order.totalAmount`.
  - On the deposit-satisfied transition: stamp `SalesOrder.depositSatisfiedAt`, evaluate commissions, post deposit wallet credit if `paymentType=DEPOSIT`.
  - On the first transition into `SalesOrderStatus.PAID`: mint `TreatmentEntitlement` for every `isProgram` item.
  - All side effects run inside one `prisma.$transaction`; notifications dispatch post-commit.
- **Example**: a 1,500 THB deposit payment satisfies a 1,500 deposit requirement; commissions evaluated, wallet credited, order moves `CONFIRMED → PARTIALLY_PAID`.

### Sales Channel (in retail context)

See Section 3 — Sales Channel above.

### Branch Stock Sale

- **Definition**: Walk-in retail transaction selling **stock items** (not services). Distinct from `SalesOrder`.
- **Related entities**: `BranchStockSale`, `BranchStockSaleItem`, `BranchStockSaleRefund`, `StockLot`, `StockMovement` (`RETAIL_SALE`).
- **Lifecycle**: `BranchStockSaleStatus = DRAFT → PAID → COMPLETED → {PARTIALLY_REFUNDED, REFUNDED}`; `CANCELLED` only from `DRAFT`.
- **Business rules**:
  - Items must belong to a `BRANCH`-type warehouse of that branch; FEFO allocation at `create()`.
  - Stock decrement happens on `complete()`, not `create()`.
  - Refund flow has its own lifecycle (`requestRefund` → `approveRefund`).
  - No commissions attached.
- **Example**: a walk-in customer buys 2 bottles of vitamin C @ 350 THB, served from the FEFO-nearest lot.

### Branch Stock Sale Item

- **Definition**: One row per (stockLotId, sale) created at `create()` after FEFO expansion.
- **Related entities**: `BranchStockSaleItem`, `StockItem`, `StockLot`.
- **Business rules**: snapshots `itemName`, `unitLabel`, `unitPrice`. Quantity is in primary units (≤6dp).
- **Example**: requesting 2 bottles where lot A has 1 and lot B has 5 produces two BranchStockSaleItem rows (1 from A, 1 from B).

### Branch Stock Sale Refund

- **Definition**: Refund attached to a branch stock sale; separate from service-sale `Refund` rows.
- **Related entities**: `BranchStockSaleRefund`, `BranchStockSale`.
- **Lifecycle**: request → approve.
- **Business rules**: distinct controller routes (`POST …/refund` then `PATCH /branch-stock-sales/refunds/:id/approve`).
- **Example**: customer returns 1 of the 2 bottles → partial refund recorded on the sale.

---

## Section 6 — Money: Refunds

### Refund

- **Definition**: A money-out event against a `SalesOrder` (not a `BranchStockSale` — see above).
- **Related entities**: `Refund`, `SalesOrder`, `Customer`, `Payment` (validation), `Wallet` (optional credit), `Commission` (revocation).
- **Lifecycle**: `RefundStatus = REQUESTED → {APPROVED, REJECTED}`, `APPROVED → COMPLETED`. `CANCELLED` exists in enum but no controller path emits it.
- **Business rules**:
  - `amount > 0`; cap = `Σ SUCCESS payments − Σ refunds in {REQUESTED, APPROVED, COMPLETED}`.
  - `refundNo` minted via advisory lock as `RFD-YYYYMMDD-####`.
  - **Approve** → just stamps approver/time.
  - **Complete** (atomic): revokes non-`PAID` commissions on the order, optionally credits customer DEPOSIT wallet (`creditToWallet=true` default), audits each side effect.
- **Example**: 500 THB partial refund of a 1,500 THB deposit → commissions revoked (none paid yet), customer's DEPOSIT wallet receives 500 back.

### Refund Type

- **Definition**: Discriminator for the refund's classification.
- **Related**: `RefundType` enum: `FULL_REFUND`, `PARTIAL_REFUND`, `CANCELLATION`.
- **Business rules**: drives reporting and downstream behavior; the refund pipeline does not gate on this value.
- **Example**: a customer cancels before any service is performed → `CANCELLATION`.

---

## Section 7 — Money: Wallet Ledger

### Wallet

- **Definition**: Balance container per customer per `WalletType`.
- **Related entities**: `Wallet`, `WalletTransaction`, `Customer`.
- **Lifecycle**: lazily created on first credit; never deleted.
- **Business rules**:
  - `@@unique([customerId, type])` — at most one wallet per customer per type.
  - All balance updates take `pg_advisory_xact_lock(hashtext('wallet:' + customerId + ':' + walletType))`.
  - Debits validate sufficient balance; transfers are atomic source-debit + destination-credit.
- **Example**: customer A has a `DEPOSIT` wallet with balance 1,500 THB after a deposit payment.

### Wallet Type

- **Definition**: Categorization of wallet purpose.
- **Related**: `WalletType` enum: `DEPOSIT`, `VOUCHER`, `REWARD`.
- **Business rules**: each customer can have one wallet per type.
- **Example**: birthday gift card → `VOUCHER` wallet; deposit payment → `DEPOSIT`.

### Wallet Transaction

- **Definition**: Append-only ledger row recording every wallet balance change.
- **Related entities**: `WalletTransaction`, `Wallet`.
- **Lifecycle**: created on every credit/debit/transfer; never updated.
- **Business rules**:
  - Stores `balanceBefore`, `balanceAfter`, `type` (`WalletTransactionType`), `referenceType` (`WalletReferenceType`), `referenceId`.
  - For `transfer`, source and destination rows share a synthetic `referenceId`.
- **Example**: payment-induced credit row: `type=CREDIT`, `referenceType=PAYMENT`, `referenceId=<paymentId>`, `balanceBefore=0`, `balanceAfter=1500`.

### Wallet Transaction Type

- **Definition**: The kind of ledger movement. `WalletTransactionType` enum: `CREDIT`, `DEBIT`, `HOLD`, `RELEASE`, `EXPIRE`, `ADJUSTMENT`, `TRANSFER_IN`, `TRANSFER_OUT`.
- **Business rules**: `HOLD/RELEASE/EXPIRE/ADJUSTMENT` are present in the enum but currently used by automation rules and reports; only `CREDIT/DEBIT/TRANSFER_IN/TRANSFER_OUT` are emitted by the wallet service today.

### Wallet Reference Type

- **Definition**: What domain object caused this wallet movement. `WalletReferenceType` enum: `SALES_ORDER`, `PAYMENT`, `REFUND`, `BRANCH_STOCK_SALE`, `MANUAL`.
- **Example**: a refund-completion credit row carries `referenceType=REFUND`, `referenceId=<refundId>`.

---

## Section 8 — Money: Commission

### Commission Rule

- **Definition**: A configurable tier row in a (branch, service group, commission type) ladder.
- **Related entities**: `CommissionRule`, `Branch`, `ServiceGroupCode`, `CommissionType`, `CommissionValueType`.
- **Lifecycle**: CRUD via `/commission-rules` (`POST/PATCH/DELETE/`bulk-upsert`/`calculate`); soft-delete via `isActive=false`.
- **Business rules**:
  - Tier resolution: `pickHighestMatchingTier(rules, subtotal)` selects the rule with the largest `minAmount ≤ subtotal`.
  - `bulk-upsert` atomically replaces an entire ladder for `(branchId, serviceGroupCode, commissionType)`.
  - `valueType` ∈ `{FIXED, PERCENTAGE}`; for `PERCENTAGE`, `value > 1` is rejected.
  - `serviceId` is **not** part of the rule (legacy column dropped in migration `20260508180004_drop_commission_rule_service_id`).
- **Example**: HQ + `RATE_HAIR` ladder: `[{minAmount: 1, value: 30, valueType: FIXED}, {minAmount: 5000, value: 0.05, valueType: PERCENTAGE}]`.

### Commission Tier

- **Definition**: A single `CommissionRule` row in a ladder; the unit of "what payout when subtotal hits this floor."
- **Related**: `CommissionRule`.
- **Business rules**: tiers within one ladder must have ascending `minAmount` and no duplicates within `(branchId, serviceGroupCode, commissionType, isActive=true)`.
- **Example**: in the ladder above, the second tier "kicks in" once the per-group subtotal reaches 5,000 THB.

### Commission Snapshot

- **Definition**: Frozen evaluation context for a commission line; immutable.
- **Related entities**: `CommissionSnapshot`, `SalesOrder`, `Lead?`, `CommissionRule?`, `User` (lead owner, sale creator).
- **Lifecycle**: created in `evaluateOrderWith`; not mutated.
- **Business rules**:
  - `@@unique([salesOrderId, serviceGroupCode, commissionType])` makes evaluation idempotent.
  - Stores branch name, recipient role code, sale creator name, lead-owner name, service name, tier rule snapshot, value (rate), and base amount.
- **Example**: `CommissionSnapshot { salesOrderId: 'so_1', serviceGroupCode: 'RATE_HAIR', commissionType: 'SALES_COMMISSION', tierRule: {minAmount: 5000, value: 0.05, valueType: 'PERCENTAGE'}, baseAmount: 15000 }`.

### Commission

- **Definition**: A payable obligation produced by an evaluation; the lifecycle row for paying recipients.
- **Related entities**: `Commission`, `CommissionSnapshot`, `SalesOrder`, `User` (recipient), `Refund?`.
- **Lifecycle**: `CommissionStatus = ELIGIBLE → LOCKED → PAID`; `REVOKED` reachable from any non-`PAID` state via refund completion.
- **Business rules**:
  - `lock()` (`ELIGIBLE → LOCKED`) and `pay()` (`LOCKED → PAID`) are explicit admin actions; `pay()` stamps `paidAt` and notifies the recipient.
  - `revokeForOrderWith` (called by refund completion) flips non-`PAID` commissions to `REVOKED` with `revokedByRefundId`, `revokedReason`.
  - `PENDING` exists in the enum but is unused — direct evaluations land at `ELIGIBLE`.
- **Example**: a SALES_COMMISSION on `SO-202605-0001` worth 750 THB lands `ELIGIBLE`; manager locks it, then pays it.

### Commission Type

- **Definition**: Which role earns the commission. `CommissionType` enum: `LEAD_REWARD`, `SALES_COMMISSION`.
- **Business rules**:
  - `LEAD_REWARD` requires `lead.currentOwnerUserId != null` and `salesOrder.depositSatisfiedAt != null`. Recipient = lead owner.
  - `SALES_COMMISSION` requires at least one `Appointment` or `CustomerServiceEvent` for the order. Recipient = order creator.
- **Example**: a converted lead's owner receives a `LEAD_REWARD`; the CS who keyed the order receives a `SALES_COMMISSION` (separate snapshots, separate lifecycles).

### Commission Value Type

- **Definition**: How the tier value is interpreted. `CommissionValueType` enum: `FIXED`, `PERCENTAGE`.
- **Business rules**: `FIXED` → payout = `value`; `PERCENTAGE` → payout = `subtotal × value` (rounded to 2dp); `value > 1` rejected for percentages.
- **Example**: tier with `valueType=FIXED, value=30` pays exactly 30 THB; tier with `valueType=PERCENTAGE, value=0.05` pays 5%.

### Eligibility (commission)

- **Definition**: Boolean predicate determining whether a commission row should be created for a `(group, type)` bucket.
- **Related**: `CommissionsService.evaluateOrderWith`.
- **Business rules**:
  - LEAD_REWARD: `salesOrder.depositSatisfiedAt != null && lead.currentOwnerUserId != null`.
  - SALES_COMMISSION: `(appointmentCount + serviceEventCount) > 0`.
- **Example**: an order whose deposit was just satisfied but with no appointments yet creates LEAD_REWARD only; SALES_COMMISSION will be evaluated again on a re-evaluation once an appointment exists.

### Commission Recipient

- **Definition**: The user who will be paid the commission.
- **Related**: `Commission.recipientUserId`, `User`.
- **Business rules**:
  - LEAD_REWARD recipient = `lead.currentOwnerUserId`.
  - SALES_COMMISSION recipient = `salesOrder.createdByUserId`.
  - Not editable post-evaluation; revocation is the only path to "undo."
- **Example**: telesales user `tele1` ends up as recipient for the converted lead's LEAD_REWARD.

---

## Section 9 — Clinical

### Appointment

- **Definition**: Scheduled clinical session.
- **Related entities**: `Appointment`, `SalesOrder`, `Customer`, `Service`, `Branch`, `User` (`doctorUserId`), `TreatmentEntitlement?`, `CustomerServiceEvent[]`.
- **Lifecycle**: `AppointmentStatus = BOOKED → {CHECKED_IN, CANCELLED}`, `CHECKED_IN → COMPLETED`. `NO_SHOW` exists in the enum but is set via report logic, not a direct controller transition.
- **Business rules**:
  - `appointmentNo` minted via per-day advisory lock as `APT-YYYYMMDD-####`.
  - Customer must match `salesOrder.customerId`; service must be on the order's items; doctor must be `ACTIVE`.
  - When `entitlementId` provided, `entitlements.assertBookable` validates customer+service match, remaining sessions, and not expired.
  - `complete()` requires at least one `CustomerServiceEvent`; if `entitlementId` is set and `entitlementConsumedAt` is `null`, it consumes a session atomically.
  - `reschedule()` only works when status is `BOOKED`.
- **Example**: appointment `APT-20260508-0001` for customer A with doctor `dr1`, scheduled `2026-05-08T09:30+07:00`, linked to `entitlementId=ent_1`.

### Customer Service Event (Service Event)

- **Definition**: An execution record for a single service performed at a single point in time.
- **Related entities**: `CustomerServiceEvent`, `Appointment?`, `SalesOrder?`, `Customer`, `Service`, `Branch`, `User` (`doctorUserId`, `employeeUserId`), `ServiceStockUsage[]`.
- **Lifecycle**: `ServiceEventStatus = IN_PROGRESS → {COMPLETED, VOIDED}`.
- **Business rules**:
  - Pre-booked path: linked `Appointment` must be `CHECKED_IN`, customer/service/branch match.
  - Walk-in path: standalone (no appointment); branch + customer + service required.
  - `consumeStock` is rejected unless event is `IN_PROGRESS`.
  - On `complete`, if all events on the parent appointment are `COMPLETED`, the appointment auto-completes.
- **Example**: doctor draws Botox from an opened container and records a `CustomerServiceEvent` linked to appointment `APT-20260508-0001`.

### Service Stock Usage

- **Definition**: Itemized record of stock consumed within a service event.
- **Related entities**: `ServiceStockUsage`, `CustomerServiceEvent`, `StockItem`, `StockLot`, `OpenedContainer?`.
- **Lifecycle**: created on each `consumeStock` or container `use` call; immutable.
- **Business rules**: `primaryQty` is in primary units; for opened containers `openedContainerId` is required and the container must match `serviceId`.
- **Example**: 0.5 vials (i.e., 25 units of Botox 50U) used from `OC-2026-0001` during a service event.

### Treatment Entitlement

- **Definition**: Pre-paid right to consume `totalSessions` of a particular `Service` for a particular `Customer`.
- **Related entities**: `TreatmentEntitlement`, `Customer`, `Service`, `SalesOrderItem` (1:1), `Appointment` (consumes).
- **Lifecycle**: minted on first `SalesOrder → PAID` for items where `service.isProgram=true`; expires via `expiredAt` or `PATCH /entitlements/:id/expire`.
- **Business rules**:
  - `totalSessions = service.defaultSessions × max(1, salesOrderItem.quantity)`.
  - `salesOrderItemId @unique` makes minting idempotent.
  - Drawdown is two-phase atomic: stamp `Appointment.entitlementConsumedAt`, then atomic `UPDATE … SET consumedSessions = consumedSessions + 1 WHERE consumedSessions < totalSessions AND not expired`. Race losers throw `409 Conflict`.
  - `remainingSessions = totalSessions - consumedSessions`.
- **Example**: paying a "Hair Growth Program × 2" line mints one entitlement with `totalSessions=14, consumedSessions=0`.

---

## Section 10 — Inventory Operations

### Stock Lot

- **Definition**: A physical batch of a stock item received into a warehouse.
- **Related entities**: `StockLot`, `StockItem`, `Warehouse`, `Supplier?`, `PurchaseReceipt?`, `OpenedContainer`, `StockMovement`, `StockTransfer`.
- **Lifecycle**: `StockLotStatus = ACTIVE → {EXHAUSTED, EXPIRED, DISCARDED}`; `QUARANTINED` exists in enum but is not set by current controllers.
- **Business rules**:
  - `(warehouseId, lotCode)` unique.
  - `quantityOnHand` decrements on dispatch, clinical use, retail sale, container open, and EXPIRE; never goes negative (decrement uses row lock + re-check).
  - FEFO ordering by `expiresAt asc nulls last, receivedAt asc`.
  - `parentStockLotId` traces transferred lots back to their source.
- **Example**: lot `BTX-2026-A` of Botox 50U, qty 100 vials, expires 2027-04-01, in `HQ-WH`.

### Opened Container

- **Definition**: A multi-use container created when a single primary unit (e.g. one vial) is opened, tracked in secondary units.
- **Related entities**: `OpenedContainer`, `StockLot`, `StockItem`, `Warehouse`, `User` (opener), `ServiceStockUsage`.
- **Lifecycle**: `OpenedContainerStatus = ACTIVE → {EMPTY, EXPIRED, DISCARDED}`. `EMPTY` is auto-set when `remainingQtyPrimary` hits 0.
- **Business rules**:
  - Stock item must allow `PARTIAL_ALLOWED` or `PARTIAL_REQUIRED`.
  - `open()` decrements lot by 1 unit and seeds `initialQtyPrimary = remainingQtyPrimary = conversionFactor`.
  - `use()` requires `serviceId` match and `IN_PROGRESS` event.
  - Optional `expiryAt` (in-use shelf life, e.g. 24h after reconstitution).
- **Example**: open one vial of Botox 50U → container with `initialQtyPrimary=50`. Each use of 5 units decrements by 5 until empty.

### Stock Movement

- **Definition**: Append-only ledger entry for any inventory delta.
- **Related entities**: `StockMovement`, `StockLot`, `OpenedContainer?`, `CustomerServiceEvent?`, `BranchStockSale?`, `StockTransfer?`.
- **Lifecycle**: created on every relevant write; never updated.
- **Business rules**:
  - Sign convention: positive `qtyDelta` for additions (`PURCHASE_IN`, `TRANSFER_IN`), negative for deductions (`TRANSFER_OUT`, `CLINICAL_USAGE`, `RETAIL_SALE`, `EXPIRE`), zero/informational for `DISCARD`/`ADJUSTMENT`/`RETURN` (depending on use).
  - Transfers must net to zero across `TRANSFER_OUT` + `TRANSFER_IN` for a transfer.
- **Example**: receiving 100 vials creates one movement `{ type: PURCHASE_IN, qtyDelta: 100, lotId, … }`.

### Stock Movement Type

- **Definition**: `StockMovementType` enum: `PURCHASE_IN`, `TRANSFER_OUT`, `TRANSFER_IN`, `CLINICAL_USAGE`, `RETAIL_SALE`, `ADJUSTMENT`, `RETURN`, `EXPIRE`, `DISCARD`.
- **Business rules**: each has fixed sign semantics (see above) and is queryable by reports.

### Stock Transfer

- **Definition**: Shipment of stock from one warehouse to another, with state machine.
- **Related entities**: `StockTransfer`, `StockTransferItem`, `Warehouse` (from + to), `StockLot` (source), `StockLot` (destination, minted on receive), `StockMovement`.
- **Lifecycle**: `StockTransferStatus = DRAFT → REQUESTED → APPROVED → IN_TRANSIT → RECEIVED`; `CANCELLED` from any non-terminal state.
- **Business rules**:
  - `transferNo` minted via per-day advisory lock as `TR-YYYYMMDD-####`.
  - `dispatch()` row-locks every source lot, decrements `quantityOnHand`, writes `TRANSFER_OUT` per item.
  - `receive()` mints destination lots (uniquified `lotCode`), copies supplier/receipt/manufacturedAt/expiresAt/unitCost, writes `TRANSFER_IN` per item.
- **Example**: transfer `TR-20260508-0001` moves 50 units of Botox from CENTRAL to HQ-WH.

### Stock Transfer Item

- **Definition**: One line of a stock transfer, addressing one source lot.
- **Related entities**: `StockTransferItem`, `StockLot` (`fromStockLotId`, `toStockLotId`).
- **Lifecycle**: created at transfer create; updated on dispatch (`quantitySent`) and receive (`quantityReceived`, `toStockLotId`).
- **Business rules**: `quantityRequested ≥ 0.000001`; cannot exceed source lot's available quantity at dispatch time.

### Expiry Sweep

- **Definition**: Daily 03:00 cron + manual admin endpoint that auto-expires past-due lots and opened containers.
- **Related entities**: `StockLot`, `OpenedContainer`, `StockMovement` (writes `EXPIRE` for lots).
- **Lifecycle**: each row updated in its own short tx; partial failures are logged but don't block the sweep.
- **Business rules**:
  - `StockLot.status === ACTIVE && expiresAt < now()` → `EXPIRED`, `quantityOnHand=0`, `EXPIRE` movement with negative delta.
  - `OpenedContainer.status === ACTIVE && expiryAt < now()` → `EXPIRED`.
- **Example**: a lot expiring 2026-05-09 23:59 is auto-flipped to `EXPIRED` at the next 03:00 sweep with a negative-delta movement preserving ledger correctness.

---

## Section 11 — Planning

### Branch Quarter Target

- **Definition**: Revenue goal for one branch in one quarter.
- **Related entities**: `BranchQuarterTarget`, `BranchQuarterTargetCategory`, `Branch`, `User` (`createdByUserId`), `SalesOrder` (read-side for progress), `Service.commissionGroupCode` (used for grouping actuals).
- **Lifecycle**: created/updated by `ADMIN`/`SUPER_BRANCH_MANAGER`/`BRANCH_MANAGER`; `(branchId, year, quarter)` unique (DB).
- **Business rules**:
  - `Σ categories[*].targetAmount === totalTarget` (±0.01 tolerance).
  - Categories must have unique `commissionGroup` (`ServiceGroupCode`).
  - `year` 2020..2100, `quarter` 1..4.
- **Example**: HQ Q1 2026, total 5,000,000 THB; categories: RATE_HAIR=3M, RATE_SKIN=1M, RATE_SURGERY=1M.

### Branch Quarter Target Category

- **Definition**: One slice of a quarter target, scoped by `commissionGroup` (`ServiceGroupCode`).
- **Related entities**: `BranchQuarterTargetCategory`, `BranchQuarterTarget`.
- **Business rules**: `@@unique([targetId, commissionGroup])`; `targetAmount ≥ 0`.
- **Example**: `RATE_HAIR` category with `targetAmount=3_000_000` belongs to the HQ Q1 2026 target.

### Quarter Progress

- **Definition**: Computed view of how much of the quarter target a branch has booked.
- **Related**: `TargetProgressService.getQuarterProgress`.
- **Business rules**:
  - "Actual" = `SUM(SalesOrderItem.netAmount)` for orders with `status=COMPLETED` and `completedAt ∈ [start, end)`, grouped by `service.commissionGroupCode`.
  - `progressPercent = round1(actual / target × 100)`; returns `null` when target is 0.
- **Example**: `{ totalTarget: 5_000_000, totalActual: 3_200_000, overallProgress: 64.0, categories: [{ commissionGroup: 'RATE_HAIR', target: 3_000_000, actual: 2_200_000, progress: 73.3 }] }`.

---

## Section 12 — Operations: Audit, Notifications, Automation

### Audit Log

- **Definition**: Immutable record of state-changing operations across all modules.
- **Related entities**: `AuditLog`, `User` (`actorUserId`), `Branch?`.
- **Lifecycle**: insert-only; queried via `/audit` endpoints (read-only).
- **Business rules**:
  - Branch-scoped readers see only their branch.
  - Filterable by `actorUserId`, `branchId`, `entityType`, `entityId`, `action` (`AuditAction` enum), date range.
- **Example**: `AuditLog { entityType: 'Refund', entityId: 'ref_1', action: 'COMPLETE', payload: { revokedCommissionIds: [...], walletTxnId: 'tx_1' } }`.

### Audit Action

- **Definition**: Discriminator on `AuditLog.action`.
- **Related**: `AuditAction` enum: `CREATE`, `UPDATE`, `DELETE`, `ASSIGN`, `TRANSFER`, `COMPLETE`, `APPROVE`, `REJECT`, `PAY`, `REFUND`, `REVOKE`, `LOGIN`, `LOGOUT`.
- **Example**: a successful login emits `action: LOGIN`; a refund completion emits `action: COMPLETE`.

### Notification

- **Definition**: A user-targeted message stored for in-app delivery (and dispatched to optional external channels).
- **Related entities**: `Notification`, `User?`, `Branch?`.
- **Lifecycle**: inserted via `notify()`; marked read; deleted via cascade if user/branch is deleted.
- **Business rules**:
  - `dedupeKey @unique` makes emit idempotent (P2002 returns existing row).
  - Channels: `IN_APP` (DB row is the source of truth), `EMAIL`/`SMS` (stub providers, log only).
  - Listing scoped to `user.id`.
- **Example**: a `COMMISSION_PAID` notification with `dedupeKey=COMMISSION_PAID|cm_1` lands in the recipient's inbox once.

### Notification Type

- **Definition**: `NotificationType` enum: `APPOINTMENT_REMINDER`, `PAYMENT_REMINDER`, `DEPOSIT_PENDING`, `LOW_STOCK`, `EXPIRING_STOCK`, `STOCK_TRANSFER`, `REFUND_REQUEST`, `REFUND_APPROVED`, `COMMISSION_ELIGIBLE`, `COMMISSION_PAID`, `WALLET_EXPIRY`, `LEAD_FOLLOWUP`, `SYSTEM`.
- **Business rules**: each type is emitted by a specific automation rule and/or inline event hook; types map to UI badges and filters.

### Notification Channel

- **Definition**: Delivery surface. `NotificationChannel` enum: `IN_APP`, `EMAIL`, `SMS`.
- **Business rules**: `InAppNotificationProvider` is the system of record (DB notification = "delivered in-app"). `EmailNotificationProvider` and `SmsNotificationProvider` are stubs that log only — extending them is an integration task.

### Notification Provider Registry

- **Definition**: Map of `NotificationChannel → NotificationChannelProvider`. `dispatch(notification)` resolves and invokes the right provider.
- **Related**: `src/notifications/providers/registry.ts`, channel provider classes.
- **Business rules**: failures are logged, not rethrown — notifications are best-effort.

### Automation Rule

- **Definition**: A scheduled (or manually-runnable) job that scans for a domain trigger and emits notifications.
- **Related entities**: implementations under `src/automation/rules/*.rule.ts`; orchestrated by `AutomationService`; cron-driven by `SchedulerService`.
- **Lifecycle**: at boot, `AutomationService` builds a `Map<code, RuleEntry>`; `runScheduled(code)` respects the `disabledRules` set; `run(code)` is a manual override.
- **Business rules**:
  - Each rule reports `{ code, createdCount, skippedCount, durationMs }` after execution.
  - Idempotency through `Notification.dedupeKey`.
  - Disabled-by-CSV via `AUTOMATION_DISABLED` env.
- **Example**: `LOW_STOCK` rule runs every 2 hours, scans `groupBy(warehouseId, stockItemId)` for sums ≤ `LOW_STOCK_THRESHOLD`, notifies branch managers + central hub.

### Recipient Resolver

- **Definition**: Helper that translates "managers of branch X" or "central stock hub" into actual user IDs.
- **Related**: `RecipientsService` (`src/automation/recipients.service.ts`).
- **Business rules**:
  - Returns only `UserStatus.ACTIVE` users.
  - `branchManagers(branchId)` = union of `BRANCH_MANAGER ∪ SUPER_BRANCH_MANAGER ∪ ADMIN` matching that branch.
  - `centralStockHub()` = union of `CENTRAL_STOCK_HUB ∪ SUPER_BRANCH_MANAGER ∪ ADMIN`.
- **Example**: `LOW_STOCK` notifications are fanned out to `branchManagers(warehouse.branchId) ∪ centralStockHub()`.

### Automation Config

- **Definition**: Runtime tunables for automation rules. Service: `AutomationConfigService`.
- **Related**: `src/config/automation.config.ts`, `env.validation.ts`.
- **Business rules**: env-driven with sensible defaults — `LOW_STOCK_THRESHOLD=5`, `EXPIRY_ALERT_DAYS=30`, `LEAD_FOLLOWUP_HOURS=48`, `APPOINTMENT_REMINDER_WINDOW_HOURS=24`, `WALLET_EXPIRY_NOTICE_DAYS=7`, `AUTOMATION_DISABLED=''`.
- **Example**: setting `LOW_STOCK_THRESHOLD=10` raises the alert sensitivity without code changes.

### BullMQ Queue

- **Definition**: Background job queue for deferred work. Three queues: `notification`, `automation`, `reporting`.
- **Related**: `src/queue/queue.module.ts`, `src/queue/workers.ts`, `src/queue/queue.constants.ts`, `src/worker.ts`.
- **Lifecycle**: producers (`QueueService`) enqueue; workers consume; both processes share Redis as broker. When `REDIS_HOST` is unset, producers no-op (debug log).
- **Business rules**:
  - Default options: `attempts: 5`, exponential backoff, retain history.
  - Notification worker calls `NotificationsService.dispatchById(id)` (re-dispatch path).
  - Automation worker calls `AutomationService.run(code)` (manual override path).
  - Reporting worker is a stub (logs only).
- **Example**: a notification can be enqueued and consumed by a worker process running on a separate host.

---

## Section 13 — Status Enums (Quick Reference)

A compact reference for every state-bearing enum. Detailed lifecycles live in `docs/business-workflows.md`.

| Enum | Values | Owner module |
|---|---|---|
| `BranchStatus` | `ACTIVE`, `INACTIVE` | `branches` |
| `WarehouseType` | `CENTRAL_HUB`, `BRANCH` | `inventory` (seed) |
| `UserStatus` | `ACTIVE`, `INACTIVE`, `SUSPENDED` | `users` |
| `RoleCode` | `ADMIN`, `TELESALES`, `CS`, `DOCTOR`, `EMPLOYEE`, `BRANCH_MANAGER`, `SUPER_BRANCH_MANAGER`, `CENTRAL_STOCK_HUB` | `users` (seed) |
| `LeadStatus` | `NEW → CONTACTED → QUALIFIED → WON\|LOST\|ARCHIVED` | `leads` |
| `SalesOrderStatus` | `DRAFT → CONFIRMED → PARTIALLY_PAID → PAID → COMPLETED\|REFUNDED`; `CANCELLED` | `sales-orders` (with payments + refunds) |
| `PaymentMethod` | `CASH`, `BANK_TRANSFER`, `CREDIT_CARD`, `DEBIT_CARD`, `QR`, `E_WALLET` | `payments` |
| `PaymentType` | `DEPOSIT`, `FULL`, `INSTALLMENT` | `payments` |
| `PaymentStatus` | `PENDING`, `SUCCESS`, `FAILED`, `VOIDED`, `REFUNDED` (current code path emits only `SUCCESS`) | `payments` |
| `AppointmentStatus` | `BOOKED → CHECKED_IN → COMPLETED`; `CANCELLED`; `NO_SHOW` (report-only) | `appointments` |
| `ServiceEventStatus` | `IN_PROGRESS → COMPLETED\|VOIDED` | `service-events` |
| `CommissionStatus` | `PENDING (unused)`, `ELIGIBLE → LOCKED → PAID`; `REVOKED` | `commissions` |
| `CommissionType` | `LEAD_REWARD`, `SALES_COMMISSION` | `commissions` |
| `CommissionValueType` | `FIXED`, `PERCENTAGE` | `commissions` |
| `ServiceGroupCode` | `RATE_SKIN`, `RATE_HAIR`, `RATE_SURGERY`, `RATE_TRANSPLANT`, `RATE_MEDICINE`, `RATE_SCULPTRA` | catalog + commissions + targets |
| `RefundType` | `FULL_REFUND`, `PARTIAL_REFUND`, `CANCELLATION` | `refunds` |
| `RefundStatus` | `REQUESTED → APPROVED → COMPLETED`; `REJECTED`; `CANCELLED` (enum-only) | `refunds` |
| `WalletType` | `DEPOSIT`, `VOUCHER`, `REWARD` | `wallet` |
| `WalletTransactionType` | `CREDIT`, `DEBIT`, `HOLD`, `RELEASE`, `EXPIRE`, `ADJUSTMENT`, `TRANSFER_IN`, `TRANSFER_OUT` (only first 2 + transfers emitted today) | `wallet` |
| `WalletReferenceType` | `SALES_ORDER`, `PAYMENT`, `REFUND`, `BRANCH_STOCK_SALE`, `MANUAL` | `wallet` |
| `StockItemType` | `RETAIL`, `CLINICAL` | `inventory/stock-items` |
| `ConsumptionStrategy` | `WHOLE_ONLY`, `PARTIAL_ALLOWED`, `PARTIAL_REQUIRED` | `inventory/stock-items` |
| `StockLotStatus` | `ACTIVE → EXHAUSTED\|EXPIRED\|DISCARDED`; `QUARANTINED` (enum-only) | `inventory/stock-lots` |
| `StockMovementType` | `PURCHASE_IN`, `TRANSFER_OUT`, `TRANSFER_IN`, `CLINICAL_USAGE`, `RETAIL_SALE`, `ADJUSTMENT`, `RETURN`, `EXPIRE`, `DISCARD` | `inventory/*` |
| `StockTransferStatus` | `DRAFT → REQUESTED → APPROVED → IN_TRANSIT → RECEIVED`; `CANCELLED` | `inventory/stock-transfers` |
| `OpenedContainerStatus` | `ACTIVE → EMPTY\|EXPIRED\|DISCARDED` | `inventory/opened-containers` |
| `SalesChannelCode` | `WALK_IN`, `DELIVERY`, `STAFF`, `EXECUTIVE`, `VIP`, `PRESENTER` | `branch-stock-sales` (seed) |
| `BranchStockSaleStatus` | `DRAFT → PAID → COMPLETED → PARTIALLY_REFUNDED\|REFUNDED`; `CANCELLED` from `DRAFT` | `branch-stock-sales` |
| `AuditAction` | `CREATE`, `UPDATE`, `DELETE`, `ASSIGN`, `TRANSFER`, `COMPLETE`, `APPROVE`, `REJECT`, `PAY`, `REFUND`, `REVOKE`, `LOGIN`, `LOGOUT` | every module |
| `NotificationType` | see Section 12 | `notifications` |
| `NotificationChannel` | `IN_APP`, `EMAIL`, `SMS` | `notifications` |

---

## Section 14 — Money Mechanics (Cheat Sheet)

| Concept | What it does | Where |
|---|---|---|
| **Deposit Satisfied** | Boolean transition that fires once `Σ SUCCESS payments ≥ depositRequired`. Stamps `SalesOrder.depositSatisfiedAt`, evaluates commissions, posts deposit wallet credit. | `payments.create` |
| **First PAID Transition** | First time `nextStatus === PAID`. Mints `TreatmentEntitlement` rows for `isProgram` items. | `payments.create` |
| **Commission Evaluation** | Bucket items by `ServiceGroupCode`, resolve highest matching tier per (group, type), create `CommissionSnapshot` + `Commission(ELIGIBLE)`. | `commissions.evaluateOrderWith` |
| **Commission Lock** | `ELIGIBLE → LOCKED`; gates payment readiness. | `commissions.lock` |
| **Commission Pay** | `LOCKED → PAID`; stamps payer + time; notifies recipient. | `commissions.pay` |
| **Commission Revocation** | Refund completion flips non-`PAID` commissions for the order to `REVOKED`. | `commissions.revokeForOrderWith` (called by `refunds.complete`) |
| **Wallet Credit** | Add to balance with advisory lock + ledger row carrying `balanceBefore/After`. | `wallet.creditWith` |
| **Wallet Debit** | Subtract with sufficient-balance check; advisory lock; ledger row. | `wallet.debitWith` |
| **Wallet Transfer** | Atomic source-debit + destination-credit; shared `referenceId`. | `wallet.transfer` |
| **Refund Cap** | `dto.amount ≤ Σ SUCCESS payments − Σ refunds in {REQUESTED, APPROVED, COMPLETED}`. | `refunds.create` |

---

## Section 15 — Inventory Mechanics (Cheat Sheet)

| Concept | Mechanism |
|---|---|
| **FEFO ordering** | `orderBy: [{ expiresAt: 'asc', nulls: 'last' }, { receivedAt: 'asc' }]` |
| **Lot decrement** | `SELECT id FROM stock_lots WHERE id = ${lotId} FOR UPDATE` then `UPDATE quantityOnHand`, mark `EXHAUSTED` at zero |
| **Container open** | Decrement source lot by 1 unit, mint container with `remainingQtyPrimary = conversionFactor` |
| **Container use** | `SELECT id FROM opened_containers WHERE id = ${id} FOR UPDATE`; decrement; mark `EMPTY` at zero |
| **Transfer dispatch** | Aggregate per source lot, lock + decrement, write `TRANSFER_OUT` |
| **Transfer receive** | Mint destination lot (uniquified `lotCode`), copy supplier/receipt/manuf/expiry/cost, write `TRANSFER_IN` |
| **Branch retail allocation** | FEFO at create; decrement at `complete()` (not `create()`) |
| **Daily expiry sweep** | Cron 03:00; per-row tx; flips `ACTIVE` past-due rows to `EXPIRED` and writes `EXPIRE` movement |

---

## Section 16 — Glossary of Common Phrases

- **"On the deposit-satisfied transition"** — the moment when a `Payment` first causes `Σ SUCCESS ≥ depositRequired`. Triggers commission evaluation + DEPOSIT wallet credit.
- **"On the first PAID transition"** — first time the cumulative payments cause the order's status to become `PAID`. Triggers `TreatmentEntitlement` minting.
- **"Tier ladder"** — the ordered list of `CommissionRule` rows for a single `(branchId, serviceGroupCode, commissionType)` triple.
- **"Branch-scoped"** — applicable to a single branch; users with non-unrestricted roles. Antonym: "unrestricted."
- **"Tx-aware helper"** — a method (`*With(tx, …)`) safe to call inside an outer `prisma.$transaction`.
- **"Snapshot fields"** — frozen columns that immortalize context at write time (e.g., `snapshotServiceName`).
- **"Drawdown"** — consuming one session against a `TreatmentEntitlement`.
- **"FEFO"** — First-Expired, First-Out allocation strategy.
- **"Deduped"** — protected by a unique key (typically `Notification.dedupeKey` or `CommissionSnapshot @@unique`).
- **"Post-commit"** — work that runs **after** the outer transaction commits (e.g. notification dispatch).
- **"Read-only / read-side"** — services like `reports`, `dashboard`, `audit`, `target-progress` that never mutate state.
- **"Soft delete"** — flagging via `deletedAt`/`isActive` instead of physical removal.
- **"Branch retail"** — the `BranchStockSale` flow (selling stock items at a branch counter), distinct from service sales.
- **"Service sale"** — the `SalesOrder` flow (selling clinical services to a customer).

---

## Section 17 — Cross-References

- **Schema**: `prisma/schema.prisma` — single source of truth for entities and enums.
- **Migrations**: `prisma/migrations/` (9 migrations, latest `20260508184017_branch_quarter_targets`).
- **Seed**: `prisma/seed.ts` — roles, permissions, sales channels, default warehouses, default admin.
- **Workflows**: `docs/business-workflows.md` — narrative + state diagrams for every flow.
- **Modules**: `docs/module-map.md` — per-module purpose / entities / APIs / dependencies.
- **Services**: `docs/backend-services.md` — class-level responsibilities and tx boundaries.
- **Frontend**: `docs/frontend-integration-guide.md` — screen-to-API mapping with payloads.
- **RBAC**: `docs/role-permission-matrix.md` — full role × action matrix.
- **System overview**: `docs/system-overview.md` — high-level architecture + runtime.

When in doubt, start with `system-overview.md` for orientation, this glossary for vocabulary, then drill into `business-workflows.md` or the specific module file.
