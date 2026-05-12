# Reverie Desk — Frontend Integration Guide

This guide maps **suggested frontend screens → required backend APIs**, with payload shapes, validation rules, and UI state transitions. All routes are JSON, mounted under `/api/v1` (Swagger: `/api/docs`). Health checks live at `/health/*`.

## Conventions

- **Auth**: send `Authorization: Bearer <accessToken>` from `POST /auth/login`. Token carries roles + branch scope.
- **Correlation**: pass an `x-request-id` header for trace correlation. The server echoes it back in error envelopes.
- **Success envelope**: `{ "success": true, "data": <payload> }`.
- **Error envelope**: `{ "success": false, "error": { "statusCode", "code", "message", "details?", "path", "timestamp", "correlationId" } }`.
- **Pagination**: list endpoints accept `?page=<int≥1>&limit=<int 1..100>` (default `page=1`, `limit=20`) and return `{ data: T[], meta: { page, limit, total } }`.
- **Decimals**: monetary fields are always sent and received as **numbers with at most 2 decimal places** (the server stores them as `Decimal(18,2)`). Stock quantities allow up to **6 decimal places**.
- **Dates**: ISO-8601 strings (e.g. `2026-05-08T09:30:00+07:00`) for datetimes; date-only fields use `YYYY-MM-DD`.
- **Phone**: Thai numbers (TH region) — `class-validator @IsPhoneNumber('TH')`.

---

## CRM

### Login Screen

- **Route**: `/login`.
- **API**: `POST /api/v1/auth/login` (rate-limited 5/min).
- **Payload**:
  ```json
  { "email": "user@example.com", "password": "Min8Chars!" }
  ```
- **Validation**: email format; password 8–72 chars.
- **Response**: `{ accessToken, user: { id, email, fullName, roles[] } }`.
- **Response**: `{ accessToken, user: { id, email, fullName, branch, roles[], permissions[] } }`.
- **UI states**: idle → loading → (success: navigate by role landing page) | (error: show inline message; on `429` show "too many attempts, retry in a minute").

### Profile Screen

- **Route**: `/me`.
- **API**: `GET /api/v1/auth/me`.
- **Response**: full user profile with `roles[]` and `permissions[]`. Use `permissions[]` to show/hide nav items (`REPORT_VIEW`, `DASHBOARD_VIEW`, etc.).

### Lead List

- **Route**: `/crm/leads`.
- **APIs**:
  - `GET /api/v1/leads?status=&branchId=&ownerId=&search=&page=&limit=`
  - `GET /api/v1/leads/:id/interactions`
  - `POST /api/v1/leads` (create)
  - `POST /api/v1/leads/:id/interactions`
  - `POST /api/v1/leads/:id/assign`
  - `PATCH /api/v1/leads/:id/status`
  - `PATCH /api/v1/leads/interactions/:id`
  - `DELETE /api/v1/leads/interactions/:id`
  - `POST /api/v1/leads/:id/convert`
- **Create payload**:
  ```json
  {
    "title": "Khun",
    "firstName": "Jane",
    "lastName": "Doe",
    "phone": "+66812345678",
    "email": "jane@example.com",
    "lineId": "janedoe",
    "facebookName": "Jane D",
    "source": "facebook-ad",
    "channel": "Line OA",
    "notes": "Interested in hair treatment",
    "branchId": "<branchId>",
    "customerId": null
  }
  ```
- **Validation**: `firstName` + `lastName` required (≤80 each); `phone` Thai format (≤30); `email` valid (≤180); `lineId`, `facebookName`, `source`, `channel` ≤120; `notes` ≤2000; optional pre-existing `customerId`.
- **UI states**: list filterable by status / owner / search. Detail view shows owner assignment history and interaction timeline.
- **State machine** (badge color): `NEW → CONTACTED → FOLLOW_UP → QUALIFIED`; `QUALIFIED → LOST`; `QUALIFIED → WON` only via `convert()`.

### Lead Interaction Timeline

- **Route**: shown inside `/crm/leads` detail panel.
- **Interaction types**: `CALL`, `CHAT`, `NOTE`, `MEETING`, `FOLLOW_UP`.
- **Create/update payload**:
  ```json
  {
    "type": "FOLLOW_UP",
    "note": "Called patient and scheduled another touchpoint",
    "outcome": "Waiting for decision",
    "nextActionAt": "2026-05-20T10:00:00.000Z"
  }
  ```
- **Behavior**: each interaction is branch-scoped via its parent lead; reads include actor attribution through `createdBy`.

### Convert Lead Modal

- **API**: `POST /api/v1/leads/:id/convert`
- **Payload (optional)**: `{ "phone"?: string, "email"?: string }` — used if the lead has no `customerId` and the user wants to match an existing customer.
- **Result**: only `QUALIFIED` leads may convert; success sets lead → `WON` and returns `{ leadId, customerId }`.

### Customer List & Detail

- **Routes**: `/crm/customers`, `/crm/customers/:id`.
- **APIs**:
  - `GET /api/v1/customers?search=&branchId=&page=&limit=`
  - `POST /api/v1/customers`
  - `GET /api/v1/customers/:id`
  - `PATCH /api/v1/customers/:id`
  - `DELETE /api/v1/customers/:id` (soft-delete)
  - `POST /api/v1/customers/:id/change-branch` (`{ "currentBranchId": "..." }`)
- **Create payload**:
  ```json
  {
    "fullName": "Somchai S.",
    "phone": "+66812345678",
    "email": "somchai@example.com",
    "notes": "VIP",
    "currentBranchId": "<branchId>"
  }
  ```
- **Validation**: `fullName` ≤120 (required); `phone` Thai format & unique (≤30); `email` valid & unique (≤180); `notes` ≤2000; `currentBranchId` optional but server requires it for non-unrestricted creators.
- **UI states**: list with search; detail tabs for entitlements (`GET /customers/:id/entitlements`), wallets (`GET /wallet/customer/:customerId`), service event history (`GET /service-events/customer/:customerId`).

---

## Branch

### Branch Directory

- **Route**: `/admin/branches`.
- **APIs**:
  - `GET /api/v1/branches`
  - `POST /api/v1/branches` (`{ code: 2..20 [A-Z0-9_-], name: 2..120 }`)
  - `PATCH /api/v1/branches/:id`
  - `PATCH /api/v1/branches/:id/activate`
  - `PATCH /api/v1/branches/:id/deactivate`
- **Validation**: `code` is auto-uppercased; restricted to letters, digits, hyphens, underscores.
- **UI states**: deactivate button blocks with a 400 error when there are active appointments or pending transfers (surface the message).

### User Management

- **Route**: `/admin/users`.
- **APIs**:
  - `GET /api/v1/users` (paginated)
  - `GET /api/v1/users/by-branch/:branchId`
  - `GET /api/v1/users/:id`
  - `POST /api/v1/users`
  - `PATCH /api/v1/users/:id`
  - `PATCH /api/v1/users/:id/assign-branch` (`{ "branchId": "..." }`)
  - `PATCH /api/v1/users/:id/unassign-branch`
- **Create payload**:
  ```json
  {
    "email": "user@example.com",
    "password": "P@ssw0rd!",
    "fullName": "User Name",
    "phone": "+66812345678",
    "branchId": "<branchId>",
    "status": "ACTIVE",
    "roles": ["DOCTOR"]
  }
  ```
- **Validation**: `password` 8–72 chars and must include lower + upper + digit + special char; `email` unique; `roles` optional `RoleCode[]` (deduped).
- **UI states**: status pill (`ACTIVE`/`INACTIVE`/`SUSPENDED`); assign-branch only for branch-scoped roles.

---

## Customer-Facing Sales (Sales Orders)

### New Sales Order Wizard

- **Route**: `/sales/orders/new`.
- **APIs (in order)**:
  1. `POST /api/v1/sales-orders` — creates DRAFT
  2. `PATCH /api/v1/sales-orders/:id` — edit while DRAFT
  3. `POST /api/v1/sales-orders/:id/confirm` — DRAFT → CONFIRMED
- **Create payload**:
  ```json
  {
    "branchId": "<branchId>",
    "customerId": "<customerId>",
    "leadId": "<optional leadId>",
    "items": [
      { "serviceId": "<serviceId>", "quantity": 1, "unitPrice": 5000, "discountAmount": 0 }
    ],
    "taxAmount": 0,
    "depositRequired": 1500,
    "currency": "THB"
  }
  ```
- **Validation**:
  - `branchId`, `customerId` required.
  - `items` ≥ 1; each item has `serviceId`, `quantity ≥ 1`, optional `unitPrice ≥ 0`, optional `discountAmount ≥ 0` (both ≤2dp).
  - `taxAmount`, `depositRequired` ≥ 0 (≤2dp).
  - `currency` length 3–8 (defaults server-side to `THB` if omitted).
  - Server enforces `depositRequired ≤ totalAmount`.
- **UI state**: badge follows `SalesOrderStatus`. Items table shows snapshotted name/code/unit price returned by the server. Confirm button hidden in any state ≠ `DRAFT`.

### Sales Order Detail

- **Route**: `/sales/orders/:id`.
- **APIs**:
  - `GET /api/v1/sales-orders/:id`
  - `POST /api/v1/sales-orders/:id/cancel`
  - `POST /api/v1/payments` (record a payment)
- **Payment payload**:
  ```json
  {
    "salesOrderId": "<orderId>",
    "amount": 1500,
    "paymentMethod": "CASH",
    "paymentType": "DEPOSIT",
    "note": "front-desk"
  }
  ```
- **Validation**:
  - `amount > 0` (≤2dp).
  - `paymentMethod` ∈ `PaymentMethod` enum.
  - `paymentType` ∈ `PaymentType` enum.
- **UI states**:
  - Badge transitions: `DRAFT → CONFIRMED → PARTIALLY_PAID → PAID` (server-driven).
  - On `paymentType=DEPOSIT` show toast "Customer wallet credited" (response includes wallet txn).
  - On full PAID, show "Treatment program entitlements minted" toast when any item is a program.
  - Cancel button only for `DRAFT`/`CONFIRMED`.

### Refund Workflow

- **Route**: `/sales/refunds`.
- **APIs**:
  - `GET /api/v1/refunds` (filters: `salesOrderId`, `customerId`, `status`, `refundType`, `branchId`)
  - `POST /api/v1/refunds`
  - `POST /api/v1/refunds/:id/approve`
  - `POST /api/v1/refunds/:id/reject`
  - `POST /api/v1/refunds/:id/complete`
- **Create payload**:
  ```json
  {
    "salesOrderId": "<orderId>",
    "amount": 500,
    "refundType": "DEPOSIT",
    "reason": "Customer cancellation",
    "creditToWallet": true
  }
  ```
- **Validation**: `amount > 0` (≤2dp); server caps at `paid − previously_refunded`. `refundType` ∈ `RefundType` enum.
- **UI states**: badge `REQUESTED → APPROVED → COMPLETED` (or `REJECTED`). On complete: show summary with revoked commissions count and (when `creditToWallet=true`) the wallet transaction id.

---

## Inventory

### Stock Item Catalogue

- **Route**: `/inventory/items`.
- **APIs**: full CRUD `/stock-items`.
- **Create payload**:
  ```json
  {
    "sku": "BTX-50",
    "name": "Botox 50U",
    "type": "CONSUMABLE",
    "primaryUnitId": "<unitId>",
    "secondaryUnitId": "<unitId>",
    "conversionFactor": 50,
    "consumptionStrategy": "PARTIAL_REQUIRED",
    "isSellable": false,
    "trackLot": true,
    "isActive": true
  }
  ```
- **Validation**: `sku` `[A-Za-z0-9_-]+` (auto-uppercased) 1–64; `name` 1–255; `type` ∈ `StockItemType`; `consumptionStrategy` ∈ enum; if `secondaryUnitId` then `conversionFactor > 0` (≤6dp).
- **UI states**: listing supports `?type=`, `?isActive=`, `?search=`. `consumptionStrategy=PARTIAL_REQUIRED` items must be opened as containers before clinical use.

### Receive Stock

- **Route**: `/inventory/receiving/new`.
- **APIs**:
  - `POST /api/v1/purchase-receipts` (optional header)
  - `POST /api/v1/stock-lots/receive` (per lot)
- **Receive payload**:
  ```json
  {
    "stockItemId": "<id>",
    "warehouseId": "<id>",
    "lotCode": "BTX-2026-A",
    "quantityReceived": 100,
    "unitCost": 12.5,
    "supplierId": "<id>",
    "purchaseReceiptId": "<id>",
    "manufacturedAt": "2026-04-01",
    "expiresAt": "2027-04-01",
    "note": "first import"
  }
  ```
- **Validation**: `lotCode` unique within warehouse, ≤64; `quantityReceived ≥ 0.000001` (≤6dp); `unitCost ≥ 0` (≤4dp); ISO date strings for date fields.
- **UI states**: success → lot appears in `GET /stock-lots?warehouseId=&status=ACTIVE`.

### Stock Transfer

- **Route**: `/inventory/transfers`.
- **APIs**:
  - `POST /api/v1/stock-transfers` (DRAFT)
  - `PATCH /api/v1/stock-transfers/:id/request`
  - `PATCH /api/v1/stock-transfers/:id/approve`
  - `POST /api/v1/stock-transfers/:id/dispatch`
  - `POST /api/v1/stock-transfers/:id/receive`
  - `PATCH /api/v1/stock-transfers/:id/cancel`
- **Create payload**:
  ```json
  {
    "fromWarehouseId": "<id>",
    "toWarehouseId": "<id>",
    "note": "weekly resupply",
    "items": [
      { "stockItemId": "<id>", "fromStockLotId": "<id>", "quantityRequested": 10 }
    ]
  }
  ```
- **Validation**: items ≥ 1; `quantityRequested ≥ 0.000001`.
- **UI state machine**: `DRAFT → REQUESTED → APPROVED → IN_TRANSIT → RECEIVED`; cancel from any non-terminal. Show locked badges and disable inappropriate buttons per state.

### Open / Use Container

- **Route**: `/clinical/containers/:id`.
- **APIs**:
  - `POST /api/v1/opened-containers/open`
  - `POST /api/v1/opened-containers/:id/use`
  - `PATCH /api/v1/opened-containers/:id/discard`
  - `PATCH /api/v1/opened-containers/:id/expire`
- **Open payload**: `{ "stockLotId": "<id>", "expiryAt"?: "2026-05-09T08:00:00+07:00" }`. Optional belt-and-suspenders fields (`stockItemId`, `warehouseId`, `initialQtyPrimary`) must match the lot's derived values when sent.
- **Validation**: lot must be `ACTIVE` and stock item must allow `PARTIAL_ALLOWED` or `PARTIAL_REQUIRED`.
- **UI states**: `ACTIVE → EMPTY` (auto when `remainingQtyPrimary` hits 0), or `DISCARDED`/`EXPIRED` via explicit calls.

### Branch Stock Sale (Walk-in Retail)

- **Route**: `/sales/branch-stock-sales`.
- **APIs**:
  - `POST /api/v1/branch-stock-sales`
  - `PATCH /api/v1/branch-stock-sales/:id/pay`
  - `PATCH /api/v1/branch-stock-sales/:id/complete`
  - `PATCH /api/v1/branch-stock-sales/:id/cancel`
  - `POST /api/v1/branch-stock-sales/:id/refund`
  - `PATCH /api/v1/branch-stock-sales/refunds/:id/approve`
- **Create payload**:
  ```json
  {
    "branchId": "<id>",
    "salesChannelId": "<id>",
    "customerId": "<optional id>",
    "discountAmount": 0,
    "note": "walk-in",
    "items": [
      { "stockItemId": "<id>", "quantity": 2, "unitPrice": 350 }
    ]
  }
  ```
- **Validation**: items ≥ 1; `quantity` ≤6dp; `unitPrice` ≥ 0 (≤2dp).
- **UI state machine**: `DRAFT → PAID → COMPLETED → PARTIALLY_REFUNDED|REFUNDED`; cancel from `DRAFT` only.

---

## Clinical

### Appointment Calendar / List

- **Route**: `/clinical/appointments`.
- **APIs**:
  - `GET /api/v1/appointments?branchId=&doctorUserId=&customerId=&status=&from=&to=&page=&limit=`
  - `POST /api/v1/appointments`
  - `GET /api/v1/appointments/:id`
  - `PATCH /api/v1/appointments/:id/check-in`
  - `PATCH /api/v1/appointments/:id/complete`
  - `PATCH /api/v1/appointments/:id/cancel`
  - `PATCH /api/v1/appointments/:id/reschedule`
- **Create payload**:
  ```json
  {
    "salesOrderId": "<id>",
    "customerId": "<id>",
    "serviceId": "<id>",
    "scheduledAt": "2026-05-08T09:30:00+07:00",
    "doctorUserId": "<id>",
    "entitlementId": "<optional id>",
    "notes": "first visit"
  }
  ```
- **Validation**: ISO date string (required); `entitlementId` optional but, when sent, must match the customer + service and have remaining sessions.
- **UI state machine**: `BOOKED → {CHECKED_IN, CANCELLED}`, `CHECKED_IN → COMPLETED`. Reschedule allowed only from `BOOKED`.

### Service Event (during the visit)

- **Route**: `/clinical/visits/:appointmentId`.
- **APIs**:
  - `POST /api/v1/service-events`
  - `POST /api/v1/service-events/:id/consume-stock` (or `…/stock-usage`)
  - `PATCH /api/v1/service-events/:id/complete`
- **Create payload**:
  ```json
  {
    "customerId": "<id>",
    "branchId": "<id>",
    "serviceId": "<id>",
    "appointmentId": "<id>",
    "salesOrderId": "<id>",
    "doctorUserId": "<id>",
    "employeeUserId": "<id>",
    "performedAt": "2026-05-08T10:00:00+07:00",
    "notes": "session 1 of 7"
  }
  ```
- **Consume-stock payload**:
  ```json
  {
    "stockLotId": "<id>",
    "quantity": 0.5,
    "openedContainerId": "<optional id>",
    "note": "1 vial portion"
  }
  ```
- **Validation**:
  - When `appointmentId` set, the appointment must be `CHECKED_IN` and customer/service/branch must match.
  - `WHOLE_ONLY` items require integer `quantity`. `PARTIAL_REQUIRED` items must include `openedContainerId`.
- **UI states**: complete buttons grey out if quantity validation fails. After completing every event on the appointment, auto-toggle the parent appointment badge to `COMPLETED` (server-driven).

### Treatment Entitlements

- **Route**: `/clinical/entitlements` (or as a tab on the customer page).
- **APIs**:
  - `GET /api/v1/customers/:id/entitlements`
  - `GET /api/v1/entitlements/:id`
  - `POST /api/v1/appointments/:id/consume`
  - `PATCH /api/v1/entitlements/:id/expire`
- **List response shape**:
  ```json
  [
    {
      "id": "<id>",
      "serviceName": "Hair Growth Program",
      "totalSessions": 7,
      "consumedSessions": 2,
      "remainingSessions": 5,
      "expiredAt": null,
      "isExpired": false
    }
  ]
  ```
- **UI states**: progress bar `consumed/total`. "Consume" button disabled when `remainingSessions === 0` or `isExpired === true`. The server returns `409 Conflict` if a race attempts double-consume.

---

## Commission

### Commission List

- **Route**: `/finance/commissions`.
- **APIs**:
  - `GET /api/v1/commissions?recipientUserId=&status=&type=&salesOrderId=&branchId=&group=&page=&limit=`
  - `GET /api/v1/commissions/:id`
  - `POST /api/v1/commissions/:id/lock`
  - `POST /api/v1/commissions/:id/pay`
  - `POST /api/v1/commissions/evaluate/:salesOrderId` (manual re-evaluation)
- **UI state machine**: `ELIGIBLE → LOCKED → PAID` (or `REVOKED` after refund). Lock disabled if not `ELIGIBLE`; Pay disabled if not `LOCKED`. Show snapshot fields (frozen branch / role / lead-owner / sale-creator / service / tier rule).

### Commission Rule Admin

- **Route**: `/finance/commission-rules`.
- **APIs**:
  - `GET /api/v1/commission-rules?branchId=&serviceGroupCode=&commissionType=&isActive=`
  - `POST /api/v1/commission-rules`
  - `PATCH /api/v1/commission-rules/:id`
  - `DELETE /api/v1/commission-rules/:id` (soft-delete)
  - `POST /api/v1/commission-rules/bulk-upsert`
  - `POST /api/v1/commission-rules/calculate` (preview)
- **Single create payload**:
  ```json
  {
    "branchId": "<id>",
    "commissionGroup": "RATE_HAIR",
    "minimumAmount": 1,
    "valueType": "FIXED",
    "value": 30,
    "roleId": null,
    "commissionType": "SALES_COMMISSION",
    "startsAt": "2026-01-01",
    "endsAt": null
  }
  ```
- **Bulk-upsert payload**:
  ```json
  [
    {
      "branchId": "<id>",
      "serviceGroupCode": "RATE_HAIR",
      "tiers": [
        { "minimum": 1, "rate": 30, "valueType": "FIXED" },
        { "minimum": 5000, "rate": 0.05, "valueType": "PERCENTAGE" }
      ]
    }
  ]
  ```
- **Validation**: `commissionGroup` ∈ `ServiceGroupCode` enum (`RATE_SKIN`, `RATE_HAIR`, `RATE_SURGERY`, `RATE_TRANSPLANT`, `RATE_MEDICINE`, `RATE_SCULPTRA`); `value` ≥ 0 (≤4dp); for `PERCENTAGE`, server rejects values > 1.
- **UI states**: tier ladder editor that calls `bulk-upsert` to save atomically. The "preview" endpoint runs against an existing sales order without persisting.

### Wallet (Customer Balance)

- **Route**: `/finance/wallets/:customerId`.
- **APIs**:
  - `GET /api/v1/wallet/customer/:customerId`
  - `POST /api/v1/wallet/credit`
  - `POST /api/v1/wallet/debit`
  - `POST /api/v1/wallet/transfer`
- **Credit payload**:
  ```json
  {
    "customerId": "<id>",
    "walletType": "DEPOSIT",
    "amount": 1000,
    "referenceType": "MANUAL_ADJUSTMENT",
    "referenceId": "<external ref>",
    "branchId": "<id>",
    "note": "Goodwill credit"
  }
  ```
- **Transfer payload**:
  ```json
  {
    "fromCustomerId": "<id>",
    "toCustomerId": "<id>",
    "fromWalletType": "DEPOSIT",
    "toWalletType": "DEPOSIT",
    "amount": 500,
    "branchId": "<id>",
    "note": "family share"
  }
  ```
- **Validation**: `amount > 0` (≤2dp); debit blocks at insufficient balance with a 400; transfer rejects same source = destination.

---

## Reports

### Reports Hub

- **Route**: `/reports`.
- **APIs (require `REPORT_VIEW` permission)**:
  - `GET /api/v1/reports/sales?branchId=&startDate=&endDate=&status=&groupBy=day|week|month&createdByUserId=`
  - `GET /api/v1/reports/payments`
  - `GET /api/v1/reports/service-events`
  - `GET /api/v1/reports/appointments`
  - `GET /api/v1/reports/inventory?warehouseId=&stockItemId=&movementType=`
  - `GET /api/v1/reports/commissions`
  - `GET /api/v1/reports/wallets`
  - `GET /api/v1/reports/refunds`
  - `GET /api/v1/reports/targets?branchId=&year=&quarter=`
- **UI states**: charting (date range picker; group-by dropdown). For branch-scoped users the `branchId` filter is auto-applied; ADMIN/SUPER_BRANCH_MANAGER may override.

### Dashboards

- **Routes**:
  - `/dashboard/executive` (ADMIN, SUPER_BRANCH_MANAGER)
  - `/dashboard/branch/:branchId` (manager + own branch)
  - `/dashboard/doctor/:userId` (self or unrestricted)
  - `/dashboard/telesales/:userId` (self or unrestricted)
- **APIs (require `DASHBOARD_VIEW`)**:
  - `GET /api/v1/dashboard/executive`
  - `GET /api/v1/dashboard/branch/:branchId`
  - `GET /api/v1/dashboard/doctor/:userId`
  - `GET /api/v1/dashboard/telesales/:userId`
- **Caching**: server caches each card; expect ~30s freshness. Re-fetch on tab focus when displaying live KPIs.

---

## Back Office

### Audit Search

- **Route**: `/admin/audit`.
- **APIs (require `AUDIT_VIEW`)**:
  - `GET /api/v1/audit?actorUserId=&branchId=&entityType=&entityId=&action=&from=&to=&page=&limit=`
  - `GET /api/v1/audit/summary?branchId=&entityType=&action=&startDate=&endDate=&recentLimit=`
  - `GET /api/v1/audit/entity/:entityType/:entityId`
  - `GET /api/v1/audit/user/:userId`
- **UI states**: timeline view per entity (chronological asc); user activity tab splits into `loginHistory[]` and `recentActions[]` with `latestActivity` timestamp.

### Notifications

- **Route**: `/notifications`.
- **APIs**:
  - `GET /api/v1/notifications?unreadOnly=&type=&page=&limit=` (`NOTIFICATION_VIEW`)
  - `GET /api/v1/notifications/summary?unreadOnly=&type=`
  - `GET /api/v1/notifications/unread-count`
  - `PATCH /api/v1/notifications/:id/read`
  - `PATCH /api/v1/notifications/read-all`
  - `POST /api/v1/notifications` (`NOTIFICATION_MANAGE`)
- **UI states**: badge count (poll `unread-count` or use BullMQ-driven push later); dropdown shows newest first; mark-as-read on click.

### Automation Console

- **Route**: `/admin/automation`.
- **APIs (require `AUTOMATION_MANAGE`)**:
  - `GET /api/v1/automation/rules`
  - `GET /api/v1/automation/runs?code=&limit=`
  - `POST /api/v1/automation/run/:code` (manual override; ignores enabled flag)
  - `PATCH /api/v1/automation/rules/:code` (`{ "enabled": true|false }`)
- **UI states**: per-rule card showing `code`, `description`, `schedule`, `enabled`, `lastRunAt`, `lastResult`. "Run now" trigger fires immediately and shows the count summary.

### Settings

- **Route**: `/settings`.
- **APIs**:
  - `GET /api/v1/settings`
  - `PATCH /api/v1/settings`
- **Access**: `ADMIN` and `SUPER_BRANCH_MANAGER` only.
- **Payload shape**:
  ```json
  {
    "general": {
      "defaultBranchId": "<optional branchId>",
      "reportWindowDays": 30
    },
    "finance": {
      "refundApprovalRoles": ["ADMIN", "SUPER_BRANCH_MANAGER", "BRANCH_MANAGER"]
    },
    "inventory": {
      "lowStockThreshold": 5,
      "expiryAlertDays": 30
    },
    "notifications": {
      "appointmentReminderWindowHours": 24,
      "walletExpiryNoticeDays": 30
    },
    "automation": {
      "leadFollowupHours": 24
    }
  }
  ```
- **UI states**: load current values, submit partial updates, then refresh from the server. Treat the response as the source of truth because defaults are merged server-side.

### Branch Quarterly Targets

- **Route**: `/back-office/targets`.
- **APIs**:
  - `POST /api/v1/targets`
  - `PATCH /api/v1/targets/:id`
  - `GET /api/v1/targets/branch/:branchId?year=&quarter=`
  - `GET /api/v1/targets/branch/:branchId/progress?year=&quarter=`
- **Create payload**:
  ```json
  {
    "branchId": "<id>",
    "year": 2026,
    "quarter": 1,
    "totalTarget": 5000000,
    "categories": [
      { "commissionGroup": "RATE_HAIR", "targetAmount": 3000000 },
      { "commissionGroup": "RATE_SKIN", "targetAmount": 1000000 },
      { "commissionGroup": "RATE_SURGERY", "targetAmount": 1000000 }
    ]
  }
  ```
- **Validation**:
  - `year` integer 2020–2100; `quarter` integer 1..4.
  - Categories ≥ 1; each `commissionGroup` unique within target.
  - `Σ categories[*].targetAmount === totalTarget` (±0.01 tolerance) — server returns `400 Bad Request` on mismatch.
  - `(branchId, year, quarter)` is unique — duplicate returns `409 Conflict`.
- **Progress response shape**:
  ```json
  {
    "branch": "Bangkok",
    "year": 2026,
    "quarter": 1,
    "totalTarget": 5000000,
    "totalActual": 3200000,
    "overallProgress": 64,
    "categories": [
      { "commissionGroup": "RATE_HAIR", "target": 3000000, "actual": 2200000, "progress": 73.3 }
    ]
  }
  ```
- **UI states**: progress bars per category + overall. Show "—" when target is `0` (server returns `null` progress).

### Sales Channel & Service catalogue

There is no public CRUD for `Service` or `SalesChannel` in this audit; both are seeded by `prisma/seed.ts`. The frontend should reference them via dropdowns sourced from sales-order / branch-stock-sale list endpoints (services appear in `SalesOrderItem.service` includes; channels appear on branch stock sale detail).

---

## Error Surface (FE-friendly mapping)

| HTTP | `error.code` | When | UI hint |
|---|---|---|---|
| 400 | `BAD_REQUEST` / `VALIDATION_ERROR` | DTO validation, business rule violations | inline error alongside field |
| 401 | `UNAUTHORIZED` | missing/expired JWT | redirect to `/login` |
| 403 | `FORBIDDEN` | role/permission/branch-scope failure | toast and disable action |
| 404 | `NOT_FOUND` / `RECORD_NOT_FOUND` | resource missing or soft-deleted | redirect to list |
| 409 | `CONFLICT` / `UNIQUE_CONSTRAINT_VIOLATION` | unique key violation, idempotency conflict | show server message |
| 422 | `RELATION_VIOLATION` | Prisma `P2014` | unexpected; show generic |
| 429 | `TOO_MANY_REQUESTS` | throttler | "Please retry in a minute" |
| 500 | `INTERNAL_ERROR` | unexpected | show fallback + correlationId for support |
| 503 | `DATABASE_UNAVAILABLE` | Prisma init failure | show maintenance banner |

The `correlationId` field on every error envelope should be exposed to the user (small grey text or copy-to-clipboard) for easier support handoff.

---

## OpenAPI / Code Generation

- The backend exposes Swagger UI at `GET /api/docs` and a JSON spec at `GET /api/docs-json` (NestJS default).
- A bundled spec is committed to `openapi/bundled.yaml` (generated via `npm run openapi:bundle`).
- The frontend can regenerate a typed client with `npm run openapi:generate` (uses `@openapitools/openapi-generator-cli`).

---

## Permissions Quick Reference (frontend feature flags)

The token's `user.permissions[]` is the source of truth for showing/hiding routes:

- `REPORT_VIEW` → `/reports/*`
- `DASHBOARD_VIEW` → `/dashboard/*`
- `AUDIT_VIEW` → `/admin/audit`
- `NOTIFICATION_VIEW` → `/notifications`
- `NOTIFICATION_MANAGE` → "Compose notification" action
- `AUTOMATION_MANAGE` → `/admin/automation`

For role-based gating (which buttons to render on a page), use `user.roles[]` with the matrix in `docs/role-permission-matrix.md`.
