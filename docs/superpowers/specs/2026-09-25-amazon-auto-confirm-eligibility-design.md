# Amazon Shipping Confirmation Eligibility Gate

## Purpose

Prevent an order from entering an Amazon shipping-confirmation batch unless
the backend can prove that it is safe to submit. The current `Sẵn sàng` badge
means only that a batch can be created; this design makes it mean **ready for
human review**, never automatically confirmed on Amazon.

## Scope

Included in this phase:

- One server-side evaluator used by the list, batch creation, and review
  endpoints.
- Machine-readable ineligibility reasons returned to the portal.
- A durable per-order Amazon-confirmation reservation so the same order cannot
  enter concurrent or later batches by accident.
- Final confirmation state derived from the Amazon Processing Report.

Excluded:

- Automatic dispatch to Seller Central.
- Automatic retry after an Amazon failure or `needs_review` result.
- Changing `order.status` from `Shipped` to `Delivered`; carrier delivery is a
  separate future concern.

## States

`amazonConfirmation` belongs to the order, not to a batch:

| State | Meaning | Can create another batch? |
| --- | --- | --- |
| absent | Never reserved. | Yes, if eligible. |
| `reserved` | Included in a reviewed-but-not-uploaded batch. | No. |
| `submitted` | Extension accepted the task or Amazon is processing it. | No. |
| `confirmed` | Amazon report proves every row activated with no errors. | No. |
| `needs_review` / `failed` | Terminal result requiring an explicit recovery flow. | No. |

The reservation records `batchId`, timestamps, and terminal Amazon batch ID.
It is acquired with a conditional update on the order before batch creation;
the operation is the idempotency boundary for `(shopId, orderId)`.

## Eligibility contract

The backend returns:

```js
{
  readyForReview: Boolean,
  reasons: ["MISSING_SHIP_BY"],
  shipDate: "YYYY-MM-DD" | null,
  actualShipAt: Date | null
}
```

`readyForReview` is true only when every automatic check passes:

1. Every non-cancelled item has the same non-empty, syntactically valid
   tracking number and a carrier.
2. `actualShipAt` exists, is a valid instant, and is not later than now.
   `shipDate` is derived from that instant in `America/Los_Angeles`.
3. The order is not cancelled and has no buyer-cancellation request.
4. `shipByDate` exists and its Los Angeles calendar date is not earlier than
   the derived `shipDate`.
5. No `amazonConfirmation` reservation or terminal confirmation exists.

The evaluator returns explicit reason codes, including
`MISSING_TRACKING`, `INVALID_TRACKING`, `MISSING_CARRIER`,
`MISSING_ACTUAL_SHIP_DATE`, `FUTURE_ACTUAL_SHIP_DATE`,
`SPLIT_OR_UNTRACKED_ITEM`, `ORDER_NOT_ELIGIBLE`,
`BUYER_CANCELLATION`, `MISSING_SHIP_BY`, `SHIP_DATE_AFTER_SHIP_BY`, and
`AMAZON_CONFIRMATION_EXISTS`.

Transparency cannot be inferred reliably from the current order data. It
therefore remains a required human review acknowledgement; it never becomes an
automatic pass merely because a tracking number exists.

## Flow

```text
Order/vendor sync
  -> evaluateAmazonConfirmationEligibility(order)
  -> Ready for review or explicit reason codes
  -> conditional per-order reservation
  -> ShippingBatch created
  -> human confirms one shipment + no Transparency
  -> extension task dispatched
  -> Amazon Processing Report reconciled
  -> confirmation state: confirmed | needs_review | failed
```

The evaluator runs again immediately before reservation and immediately before
dispatch. A stale UI response cannot bypass a later cancellation, changed
carrier event, Ship By change, or existing submission.

## Extension preflight

This phase does not dispatch automatically. Manual dispatch must still reject
when the target machine has no live socket for the selected shop. The existing
presence room is the initial online check; a later automatic-dispatch phase
must additionally obtain an extension preflight acknowledgement that Seller
Central is logged in and its active shop matches the selected LNG shop.

## Amazon result

The Processing Report remains the final authority:

- `confirmed` only if `recordsProcessed` and `recordsActivated` equal the
  batch row count and `errorCount` is zero.
- Any other terminal report becomes `needs_review` or `failed` and keeps the
  reservation locked.
- The portal's “Đã gửi Amazon” display derives from `confirmed`, not merely
  from an extension task completing upload.

## Portal behaviour

- Replace `Sẵn sàng` with `Sẵn sàng review`.
- Disabled rows show their first reason and expose all reason codes in detail.
- Show `Chờ Amazon xử lý`, `Đã xác nhận`, and `Cần xử lý` separately.
- Do not show an auto-push toggle in this phase.

## Verification

- Unit tests cover every reason code, Los Angeles date boundaries, all-item
  tracking equality, cancellation, and Ship By comparisons.
- Concurrency test proves two batch requests can reserve an order only once.
- Endpoint tests prove re-evaluation occurs at batch creation and dispatch.
- Reconciliation tests prove only an error-free full Processing Report marks
  an order `confirmed`.
