# Viettel Post Fulfillment Ownership Design

## Goal

Make Fulfillment the vendor-of-record for Viettel Post: it owns carrier credentials and wallet, creates/cancels shipments, retrieves labels, and tracks carrier progress. LNG owns marketplace ingestion, production readiness, order lifecycle, and marketplace tracking upload.

## Decisions

- Fulfillment, never LNG, stores or uses Viettel Post credentials, wallet balance, pricing, pickup configuration, or label-generation access.
- LNG sends an order to Fulfillment only after its existing production-readiness rules pass.
- Fulfillment is the source of truth for fulfillment execution. LNG treats an accepted order as `sent to fulfillment`, not shipped.
- Fulfillment sends signed lifecycle events to LNG. LNG does not poll Viettel Post and does not call its shipment APIs.
- The existing Fulfillment tenant API key remains the authentication mechanism for `POST /api/portal/orders`. It must have `orders:write` scope.

## Ownership boundary

| Concern | LNG | Fulfillment |
| --- | --- | --- |
| Marketplace order, QC, production readiness | Owns | Consumes immutable order snapshot |
| Production/vendor work | Observes lifecycle | Owns execution |
| Viettel Post credential and wallet | Never receives | Stores tenant-scoped encrypted credential |
| Create/cancel shipment and label | Never calls VP | Calls VP through its carrier adapter |
| Carrier shipment, label URL, tracking timeline | Mirrors from event | Source of truth |
| Marketplace tracking upload | Owns after carrier-confirmed handoff | Supplies tracking and actual ship evidence |

## Lifecycle

```text
READY_TO_SEND_VENDOR
  -> LNG submits order with stable externalOrderId/lngOrderId
  -> FULFILLMENT_ACCEPTED
  -> IN_PRODUCTION
  -> SHIPMENT_CREATED
  -> LABEL_READY
  -> CARRIER_HANDOFF_CONFIRMED
  -> LNG uploads marketplace tracking
```

`FULFILLMENT_ACCEPTED` only confirms that Fulfillment durably accepted the order. It must not mark the LNG order `Shipped` or upload marketplace tracking. Only `CARRIER_HANDOFF_CONFIRMED` contains the carrier-confirmed `actualShipAt` that makes the order eligible for marketplace upload.

## Canonical provider contract

Fulfillment owns the canonical, machine-checkable contract at `lng-fulfillment/docs/contracts/lng-fulfillment-lifecycle.v1.openapi.yaml`. The implementation plan creates it before either service changes runtime behavior. LNG consumes that contract; it does not maintain a handwritten duplicate.

### Order submission

LNG continues to call `POST /api/portal/orders` with the tenant bearer key. Every submitted order must carry a stable `externalOrderId` equal to the LNG order id. Retrying the same order must be idempotent: Fulfillment returns the already-created fulfillment order rather than creating a duplicate.

The response must distinguish:

- `accepted`: request was durably stored by Fulfillment;
- `duplicate`: the same `externalOrderId` was already stored;
- `rejected`: validation or authorization failed before acceptance.

### Fulfillment-to-LNG event endpoint

LNG adds one provider-specific endpoint under its existing vendor webhook router:

`POST /api/vendor-webhooks/fulfillment-platform-v2`

Fulfillment signs the exact UTF-8 request body using HMAC-SHA256 and sends:

- `X-LNG-Event-Id`: UUID; globally unique and required;
- `X-LNG-Event-Timestamp`: Unix seconds; reject events outside the allowed clock window;
- `X-LNG-Signature`: `sha256=<hex digest>`;
- `Content-Type: application/json`.

LNG verifies the HMAC using `FULFILLMENT_LIFECYCLE_WEBHOOK_SECRET`, compares in constant time, rejects stale timestamps, and persists the event id before changing an order. The secret is an LNG environment value; it is never in an order payload, database response, or log.

### Event body

All events use one envelope:

```json
{
  "eventId": "uuid",
  "eventType": "shipment.label_ready",
  "occurredAt": "2026-10-07T00:00:00.000Z",
  "tenantReference": "lng",
  "externalOrderId": "LNG order id",
  "fulfillmentOrderId": "opaque fulfillment id",
  "shipment": {
    "shipmentId": "opaque fulfillment shipment id",
    "carrierCode": "VIETTEL_POST",
    "carrierShipmentId": "opaque VP shipment id",
    "trackingNumber": "string or null",
    "labelUrl": "https URL or null",
    "status": "LABEL_READY",
    "actualShipAt": null
  },
  "failure": null
}
```

Allowed `eventType` values are `fulfillment.accepted`, `shipment.created`, `shipment.label_ready`, `tracking.updated`, `shipment.carrier_handoff_confirmed`, `shipment.cancelled`, and `shipment.failed`.

`shipment.carrier_handoff_confirmed` requires non-empty `trackingNumber` and an ISO timestamp in `actualShipAt`. `shipment.failed` requires `failure.code` and a safe, user-displayable `failure.message`. Events never contain a Viettel Post credential, wallet balance, raw carrier response, or unnecessary customer PII.

## Delivery and recovery

- Fulfillment records outbound events in an outbox before delivery, retries non-2xx responses with bounded exponential backoff, and sends the same `eventId` on every retry.
- LNG accepts duplicate event ids with a successful idempotent response and performs no second lifecycle transition.
- Fulfillment exposes a tenant-authenticated read endpoint by `externalOrderId` for operational recovery only. LNG invokes it manually or through a bounded reconciliation job after delivery failure; it never falls back to Viettel Post polling.
- Event delivery failure does not roll back a created VP shipment or label. It remains visible to Fulfillment operations until delivery succeeds or is replayed.

## Security and operations

- The Fulfillment VP credential is encrypted and tenant-scoped; only its OWNER/ADMIN can manage it.
- Carrier creation is disabled unless the selected Fulfillment carrier account has live mode enabled.
- All callback mutations are authenticated, rate-limited, audited, and idempotent.
- Callback logs store metadata, event id, response status, and safe failure reason only; they do not store HMAC secrets or raw credential material.
- Existing LNG pull schedulers may remain temporarily for other carriers but must not be used for the new VP lifecycle; VP reconciliation uses the Fulfillment read endpoint.

## Out of scope

- Moving existing YunExpress ownership.
- Migrating historic VP shipments.
- Cross-vendor shared wallet allocation or automatic wallet top-up.
- Changing marketplace-specific tracking policy beyond using the existing carrier-handoff gate.

## Success criteria

1. A ready LNG order is accepted exactly once by Fulfillment after retry.
2. Fulfillment creates VP shipment and label using only its tenant credential.
3. LNG receives a verified, idempotent event and shows the resulting tracking/label lifecycle without holding VP secrets.
4. Marketplace upload occurs only after the carrier-handoff event.
5. A failed callback can be retried or reconciled without a duplicate shipment or duplicate marketplace upload.
