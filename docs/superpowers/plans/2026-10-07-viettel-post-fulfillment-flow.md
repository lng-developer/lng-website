# Viettel Post Fulfillment Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fulfillment the only service that uses Viettel Post credentials and emits a signed shipment lifecycle to LNG.

**Architecture:** Fulfillment receives idempotent portal orders, owns a tenant-scoped `VIETTEL_POST` carrier account, and writes outbound lifecycle events to a transactional outbox. LNG verifies and deduplicates those events before mirroring safe shipment state and invoking its existing marketplace tracking gate.

**Tech Stack:** Next.js 15, TypeScript, Prisma/PostgreSQL, Node.js/Express, Mongoose, Jest, native `fetch`/Axios, HMAC-SHA256.

**Spec:** `docs/superpowers/specs/2026-10-07-viettel-post-fulfillment-ownership-design.md`

## Global Constraints

- The contract source of truth is `lng-fulfillment/docs/contracts/lng-fulfillment-lifecycle.v1.openapi.yaml`; LNG must consume it and must not duplicate its schema.
- Only Fulfillment holds VP OAuth/client credentials and wallet configuration; no VP secret, wallet state, or raw VP response may enter LNG.
- All tenant data access is tenant-scoped; carrier credentials stay encrypted and are manageable only by Fulfillment OWNER/ADMIN.
- Delivery callbacks sign exact UTF-8 bytes with HMAC-SHA256, have a bounded timestamp window, and are idempotent by `eventId`.
- `fulfillment.accepted` and `shipment.label_ready` never mark an LNG order shipped or upload marketplace tracking; only `shipment.carrier_handoff_confirmed` with tracking and `actualShipAt` may do so.
- Do not call live carrier APIs in tests or during local development; mock HTTP and use the VP staging environment only in an explicitly authorized integration run.

## Review Focus

- A VP timeout after accepting a create request must not cause a second shipment when retried; Task 2 covers provider idempotency/recovery.
- A valid HMAC replay with the same `eventId` must return success without a second LNG state transition; Task 5 covers dedupe.
- A correct signature with stale timestamp or wrong tenant/order must be rejected before mutation; Task 5 covers both.
- `labelUrl` or tracking received before carrier handoff must not trigger marketplace upload; Task 6 covers this ordering.
- Callback retry exhaustion must leave a replayable Fulfillment outbox record and must not expose raw payload/secret in logs; Task 4 covers this.

---

### Task 1: Establish the provider-owned API contract

**Files:**
- Create: `C:\Users\stack\Task\lng-fulfillment\docs\contracts\lng-fulfillment-lifecycle.v1.openapi.yaml`
- Create: `C:\Users\stack\Task\lng-fulfillment\docs\contracts\examples\shipment-label-ready.json`
- Create: `C:\Users\stack\Task\lng-fulfillment\docs\contracts\examples\carrier-handoff-confirmed.json`
- Modify: `C:\Users\stack\Task\lng-fulfillment\README.md`
- Test: `C:\Users\stack\Task\lng-fulfillment\src\modules\callback\contract.test.ts`

**Interfaces:**
- Produces canonical schemas `LifecycleEventEnvelope`, `FulfillmentShipment`, `Failure`, and `PortalOrderAccepted`.
- Defines `POST /api/portal/orders`, `GET /api/portal/orders/{externalOrderId}`, and LNG callback delivery semantics.

- [ ] **Step 1: Write contract tests and JSON examples**

Assert all seven event names, required `eventId`/`externalOrderId`/`occurredAt`, handoff-only `actualShipAt`, and absence of credential fields.

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `npm test -- src/modules/callback/contract.test.ts`

Expected: FAIL because the contract and validator do not exist.

- [ ] **Step 3: Add the OpenAPI 3.1 contract and a small local validator used by the test**

Keep the validator test-only if the repository has no OpenAPI runtime dependency; do not add a generator or dependency solely for this contract.

- [ ] **Step 4: Run contract verification**

Run: `npm test -- src/modules/callback/contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/contracts README.md src/modules/callback/contract.test.ts
git commit -m "docs: define fulfillment lifecycle contract"
```

### Task 2: Add the tenant-scoped Viettel Post carrier adapter

**Files:**
- Modify: `C:\Users\stack\Task\lng-fulfillment\prisma\schema.prisma`
- Create: `C:\Users\stack\Task\lng-fulfillment\prisma\migrations\20261007100000_add_viettel_post_carrier\migration.sql`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\carrier\types.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\carrier\service.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\integrations\viettel-post\adapter.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\integrations\viettel-post\client.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\integrations\viettel-post\mapping.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\integrations\viettel-post\normalize.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\integrations\viettel-post\register.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\carrier\index.ts`
- Test: `C:\Users\stack\Task\lng-fulfillment\src\integrations\viettel-post\adapter.test.ts`

**Interfaces:**
- Consumes `CarrierAdapter` and `resolveCarrierRuntimeCredentials`.
- Produces registered carrier code `VIETTEL_POST`; `createShipment`, `getTracking`, and `cancelShipment` return normalized carrier results.

- [ ] **Step 1: Write mocked adapter tests**

Cover OAuth token caching without secret logs, create success with tracking/label, rejected response mapping, and timeout/duplicate recovery. Use fake credentials and mocked `fetch` only.

- [ ] **Step 2: Run the adapter tests to verify failure**

Run: `npm test -- src/integrations/viettel-post/adapter.test.ts`

Expected: FAIL because `VIETTEL_POST` is unsupported.

- [ ] **Step 3: Implement the smallest adapter and encrypted credential payload**

Add `VIETTEL_POST` to supported carrier codes and allow only the documented staging/live endpoint, OAuth fields, pickup configuration, and `liveEnabled` in the encrypted credential payload. Map shipment creation to the VP API and persist only safe normalized results.

- [ ] **Step 4: Validate migration and adapter tests**

Run: `npm run prisma:validate && npm test -- src/integrations/viettel-post/adapter.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma src/modules/carrier src/integrations/viettel-post
git commit -m "feat: add Viettel Post carrier adapter"
```

### Task 3: Make portal intake explicitly idempotent and observable

**Files:**
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\order\service.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\order\repository.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\order\types.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\app\api\portal\orders\route.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\app\api\portal\orders\[externalOrderId]\route.ts`
- Test: `C:\Users\stack\Task\lng-fulfillment\src\modules\order\service.test.ts`

**Interfaces:**
- Consumes canonical `PortalOrderAccepted` response.
- Produces `accepted` or `duplicate` per individual `externalOrderId`, retaining current batch compatibility fields.

- [ ] **Step 1: Add intake tests**

Assert first submission returns `accepted`, identical retry returns `duplicate` and the same fulfillment order id, and `GET` returns safe current processing/shipment state scoped to the bearer-key tenant.

- [ ] **Step 2: Run intake tests to verify failure**

Run: `npm test -- src/modules/order/service.test.ts`

Expected: FAIL because current response only reports inserted/skipped counts.

- [ ] **Step 3: Extend the response without breaking existing callers**

Keep existing batch totals, add stable per-order acceptance records, and expose only safe status via the existing order-status route.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- src/modules/order/service.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/order src/app/api/portal/orders
git commit -m "feat: expose idempotent portal order intake"
```

### Task 4: Add Fulfillment lifecycle outbox and signed delivery

**Files:**
- Modify: `C:\Users\stack\Task\lng-fulfillment\prisma\schema.prisma`
- Create: `C:\Users\stack\Task\lng-fulfillment\prisma\migrations\20261007110000_add_lifecycle_event_outbox\migration.sql`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\modules\callback\service.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\modules\callback\repository.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\modules\callback\types.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\callback\index.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\shipment\service.ts`
- Modify: `C:\Users\stack\Task\lng-fulfillment\src\modules\shipment\repository.ts`
- Create: `C:\Users\stack\Task\lng-fulfillment\src\app\api\cron\lifecycle-events\route.ts`
- Test: `C:\Users\stack\Task\lng-fulfillment\src\modules\callback\service.test.ts`

**Interfaces:**
- Consumes shipment/order state transitions and `FULFILLMENT_LIFECYCLE_CALLBACK_URL` plus `FULFILLMENT_LIFECYCLE_WEBHOOK_SECRET` server environment values.
- Produces one persisted outbox event per semantic lifecycle transition and `deliverPendingLifecycleEvents(now)`.

- [ ] **Step 1: Write outbox tests**

Cover atomic event insertion with a shipment transition, exact-byte signature headers, transient retry with unchanged `eventId`, permanent 4xx failure visibility, and payload redaction.

- [ ] **Step 2: Run callback tests to verify failure**

Run: `npm test -- src/modules/callback/service.test.ts`

Expected: FAIL because no outbox or dispatcher exists.

- [ ] **Step 3: Implement transactional outbox and bounded delivery**

Store immutable safe envelope bytes plus attempt metadata. Deliver from the cron route using an internal cron secret; cap attempts/backoff and leave failed records replayable. Emit accepted, shipment created/label-ready/cancelled/failed, tracking-updated, and carrier-handoff events from the transaction that changes state.

- [ ] **Step 4: Verify callback behavior and schema**

Run: `npm run prisma:validate && npm test -- src/modules/callback/service.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prisma src/modules/callback src/modules/shipment src/app/api/cron/lifecycle-events
git commit -m "feat: deliver fulfillment lifecycle callbacks"
```

### Task 5: Receive signed Fulfillment lifecycle events in LNG

**Files:**
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\routes\vendorWebhook.routes.js`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\controllers\vendorWebhook.controller.js`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\service\vendorWebhook.service.js`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\models\vendorWebhookLog.model.js`
- Create: `C:\Users\stack\Task\lng-website-lng-dev\src\models\fulfillmentLifecycleEvent.model.js`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\models\index.js`
- Test: `C:\Users\stack\Task\lng-website-lng-dev\src\service\__tests__\fulfillmentLifecycleWebhook.service.test.js`
- Test: `C:\Users\stack\Task\lng-website-lng-dev\src\controllers\__tests__\vendorWebhook.controller.test.js`

**Interfaces:**
- Consumes `LifecycleEventEnvelope` and HMAC headers from Task 4.
- Produces `handleFulfillmentLifecycleWebhook({ payload, req })`, an idempotent `200 { ok: true, duplicate }` response, and a TTL-backed received-event record keyed by `eventId`.

- [ ] **Step 1: Add failing webhook tests**

Cover valid HMAC acceptance, malformed/expired/wrong signature rejection, repeat event id, unknown LNG order, and a payload with an unsupported event type. Assert raw PII-rich payload is not put in `VendorWebhookLog` for this provider.

- [ ] **Step 2: Run webhook tests to verify failure**

Run: `npm test -- src/service/__tests__/fulfillmentLifecycleWebhook.service.test.js src/controllers/__tests__/vendorWebhook.controller.test.js`

Expected: FAIL because the provider route and event store do not exist.

- [ ] **Step 3: Implement exact-body HMAC verification and idempotent persistence**

Reuse `req.rawBody` and constant-time comparison. Register only `fulfillment-platform-v2` as the new provider path, validate contract fields before lookup, insert `eventId` with a unique index, and record safe delivery metadata instead of raw content.

- [ ] **Step 4: Run focused LNG verification**

Run: `npm test -- src/service/__tests__/fulfillmentLifecycleWebhook.service.test.js src/controllers/__tests__/vendorWebhook.controller.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes src/controllers src/service src/models
git commit -m "feat: receive fulfillment lifecycle webhooks"
```

### Task 6: Map lifecycle events to LNG lifecycle without premature shipment

**Files:**
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\service\vendorWebhook.service.js`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\models\etsyOrder.model.js`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\models\orderCustomProduct.model.js`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\src\service\fulfillmentTrackingPullScheduler.js`
- Test: `C:\Users\stack\Task\lng-website-lng-dev\src\service\__tests__\fulfillmentLifecycleWebhook.service.test.js`
- Test: `C:\Users\stack\Task\lng-website-lng-dev\src\service\__tests__\fulfillmentTrackingPullScheduler.test.js`

**Interfaces:**
- Consumes accepted/label/tracking/handoff/failed/cancelled event transitions from Task 5.
- Produces safe `vendor_submissions.fulfillment_platform_v2` lifecycle fields and calls the existing tracking upload path only for confirmed handoff.

- [ ] **Step 1: Extend lifecycle tests**

Assert `fulfillment.accepted` records sent/accepted without `Shipped`; `shipment.label_ready` stores label/tracking as pending; `shipment.carrier_handoff_confirmed` writes `actualShipAt` once and schedules marketplace upload; older or duplicate events cannot regress the lifecycle.

- [ ] **Step 2: Run the lifecycle tests to verify failure**

Run: `npm test -- src/service/__tests__/fulfillmentLifecycleWebhook.service.test.js`

Expected: FAIL because generic vendor tracking treats any shipped-looking update as shipment confirmation.

- [ ] **Step 3: Implement provider-specific monotonic mapping**

Keep legacy generic webhook behavior unchanged. For Fulfillment events, mirror safe IDs/status/tracking/label URL, reject invalid status regression, and bypass VP polling for orders managed by this provider.

- [ ] **Step 4: Verify scheduler isolation and lifecycle behavior**

Run: `npm test -- src/service/__tests__/fulfillmentLifecycleWebhook.service.test.js src/service/__tests__/fulfillmentTrackingPullScheduler.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service src/models
git commit -m "feat: mirror fulfillment shipment lifecycle"
```

### Task 7: Verify both boundaries in staging without a live VP mutation

**Files:**
- Modify: `C:\Users\stack\Task\lng-fulfillment\.env.example`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\.env.example`
- Modify: `C:\Users\stack\Task\lng-fulfillment\README.md`
- Modify: `C:\Users\stack\Task\lng-website-lng-dev\README.md`
- Test: focused tests from Tasks 1–6

**Interfaces:**
- Consumes the frozen contract and both environment configurations.
- Produces an operator runbook for a sandbox callback replay, not a production carrier order.

- [ ] **Step 1: Add environment/documentation tests or configuration assertions**

Assert missing callback URL/secret disables delivery safely and no documentation asks operators to put VP credentials in LNG.

- [ ] **Step 2: Run the configuration check to verify failure**

Run the new focused configuration test command documented by the implementation.

Expected: FAIL until required callback configuration is described and guarded.

- [ ] **Step 3: Document safe staging procedure and implement configuration guards**

Document a mocked or replayed lifecycle event first; require explicit `liveEnabled` before any VP create call. Do not include credential values in examples.

- [ ] **Step 4: Run final focused verification**

Run: Fulfillment `npm run prisma:validate && npm test -- src/modules/callback src/integrations/viettel-post`; LNG `npm test -- src/service/__tests__/fulfillmentLifecycleWebhook.service.test.js src/controllers/__tests__/vendorWebhook.controller.test.js`.

Expected: PASS, with no outbound VP call.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document fulfillment lifecycle callbacks"
```
