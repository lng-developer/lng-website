# Etsy Reset APIs For FE

This document describes two Etsy reset APIs for frontend integration.

Base API prefix:

```txt
/api/etsy
```

Both APIs require the same auth token flow as other protected Etsy order actions.

## 1. Reset Etsy Base Cost

Use this when FE needs to clear Etsy cost calculation data so the order can be calculated again.

### Endpoint

```http
PUT /api/etsy/reset-base-cost
```

### Request Body

```json
{
  "orderId": "ETSY_ORDER_ID"
}
```

### Success Response

```json
{
  "message": "Etsy order base cost reset successfully",
  "orderId": "ETSY_ORDER_ID",
  "base_cost": 0,
  "removedCostBreakdownCount": 2
}
```

### Backend Behavior

The API resets these fields:

```txt
base_cost = 0
base_cost_shipping_groups = []
base_cost_computed_at = null
items[].cost_breakdown = undefined
```

It also writes an order history entry:

```txt
action = UPDATE_BASE_COST
```

### FE Notes

- Send exactly one `orderId`.
- After success, refresh the Etsy order row/detail so `base_cost` and no-cost indicators are updated.
- `removedCostBreakdownCount` tells FE how many items had cost breakdown removed.

### Error Responses

Missing `orderId`:

```json
{
  "message": "Missing orderId"
}
```

Order not found:

```json
{
  "message": "Etsy order not found"
}
```

Server error:

```json
{
  "message": "Failed to reset Etsy order base cost",
  "error": "..."
}
```

## 2. Reset Etsy Scale In Bulk

Use this when FE needs to send one or more Etsy orders back to the beginning of the Scale flow.

### Endpoint

```http
PUT /api/etsy-orders/scale/orders/reset/bulk
```

### Request Body

```json
{
  "orderIds": ["ETSY_ORDER_ID_1", "ETSY_ORDER_ID_2"],
  "note": "redo"
}
```

### Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `orderIds` | `string[]` | Yes | Must be a non-empty array. |
| `note` | `string` | No | If provided, this value is written to every item's `qc_note`. If omitted, `qc_note` becomes empty string. |

### Success Response

The API supports partial success. FE should read each item in `results`.

```json
{
  "message": "Bulk reset completed",
  "total": 2,
  "results": [
    {
      "orderId": "ETSY_ORDER_ID_1",
      "status": "success",
      "scale_overall_status": "Need Scale"
    },
    {
      "orderId": "ETSY_ORDER_ID_2",
      "status": "failed",
      "error": "Etsy order not found"
    }
  ]
}
```

### Backend Behavior

For every found order, the API resets these fields:

```txt
items[].scale_status = "Need Scale"
items[].fulfillment_file = empty
items[].qc_note = note || ""
scale_overall_status = "Need Scale"
status = "New"
scaleId = null
```

It also writes an order history entry:

```txt
action = RESET_SCALE_BULK
```

### FE Notes

- This is a bulk endpoint. It can return a mix of successful and failed order resets.
- Treat the HTTP success response as "request processed", not "all orders succeeded".
- Show per-order errors from `results[].error`.
- After success, refresh Scale/QC list data and statistics because statuses and counts change.
- For a single order reset, call the same endpoint with a one-item array:

```json
{
  "orderIds": ["ETSY_ORDER_ID"]
}
```

### Error Responses

Invalid `orderIds`:

```json
{
  "message": "orderIds must be a non-empty array"
}
```

Server error:

```json
{
  "message": "Bulk reset failed",
  "error": "..."
}
```

## Suggested FE Integration

## 3. Update Etsy Order Item Quantity

Use this when FE needs to edit the quantity of one Etsy item.

### Endpoint

```http
PATCH /api/etsy-orders/:orderId/items/:transactionId/quantity
```

Etsy item identity is `transactionId`. The response also returns `orderItemId` with the same value for FE compatibility.

### Request Body

```json
{
  "quantity": 3
}
```

### Success Response

```json
{
  "message": "Etsy order item quantity updated successfully",
  "data": {
    "orderId": "ETSY_ORDER_ID",
    "transactionId": "ETSY_TRANSACTION_ID",
    "orderItemId": "ETSY_TRANSACTION_ID",
    "quantity": 3,
    "numberOfItems": 5
  }
}
```

If quantity is unchanged:

```json
{
  "message": "No change",
  "data": {
    "orderId": "ETSY_ORDER_ID",
    "transactionId": "ETSY_TRANSACTION_ID",
    "orderItemId": "ETSY_TRANSACTION_ID",
    "quantity": 3
  }
}
```

### Backend Behavior

The API updates:

```txt
items[].quantity
numberOfItems = sum(items[].quantity)
```

It also writes an order history entry:

```txt
action = UPDATE_ITEM_QUANTITY
```

### Error Responses

Missing quantity:

```json
{
  "message": "Quantity is required"
}
```

Invalid quantity:

```json
{
  "message": "Quantity must be an integer greater than 0"
}
```

Order or item not found:

```json
{
  "message": "Etsy order or order item not found"
}
```

## 4. Open Case In Etsy Order

Use this when FE needs to attach one or more case IDs to an Etsy order.

### Endpoint

```http
PUT /api/etsy-orders/open-case
```

### Request Body

```json
{
  "orderId": "ETSY_ORDER_ID",
  "caseIds": ["CASE_OBJECT_ID_1", "CASE_OBJECT_ID_2"]
}
```

### Success Response

```json
{
  "message": "Case field appended successfully",
  "orderId": "ETSY_ORDER_ID",
  "case": ["CASE_OBJECT_ID_1", "CASE_OBJECT_ID_2"]
}
```

If all passed cases already exist on the order:

```json
{
  "message": "No new case added",
  "orderId": "ETSY_ORDER_ID",
  "case": ["CASE_OBJECT_ID_1"]
}
```

### Backend Behavior

The API appends only new case IDs and keeps existing case IDs.

It also writes an order history entry when a new case is added:

```txt
action = OPEN_CASE
```

### Error Responses

Invalid body:

```json
{
  "message": "Missing orderId or caseIds (should be an array)"
}
```

Order not found:

```json
{
  "message": "Etsy order not found"
}
```

## 5. Remove Case From Etsy Order

Use this when FE needs to detach one or more case IDs from an Etsy order.

### Endpoint

```http
PUT /api/etsy-orders/remove-case
```

### Request Body

```json
{
  "orderId": "ETSY_ORDER_ID",
  "caseIds": ["CASE_OBJECT_ID_1"]
}
```

### Success Response

```json
{
  "message": "Case(s) removed successfully",
  "orderId": "ETSY_ORDER_ID",
  "case": ["CASE_OBJECT_ID_2"]
}
```

If none of the passed cases exist on the order:

```json
{
  "message": "No case removed",
  "orderId": "ETSY_ORDER_ID",
  "case": ["CASE_OBJECT_ID_2"]
}
```

### Backend Behavior

The API removes matching case IDs from the order.

It also writes an order history entry when at least one case is removed:

```txt
action = REMOVE_CASE
```

### Error Responses

Invalid body:

```json
{
  "message": "Missing orderId or caseIds (should be an array)"
}
```

Invalid case IDs:

```json
{
  "message": "Invalid caseId(s)",
  "invalidIds": ["bad-id"]
}
```

Order not found:

```json
{
  "message": "Etsy order not found"
}
```

### Reset Base Cost Button

Use on Etsy order detail/list row when user wants to clear cost calculation:

```ts
await api.put("/api/etsy-orders/reset-base-cost", {
  orderId,
});
```

Then refresh:

```txt
Etsy order list/detail
Base cost/no-cost indicators
```

### Reset Scale Bulk Action

Use on Etsy Scale/QC list for selected rows:

```ts
await api.put("/api/etsy-orders/scale/orders/reset/bulk", {
  orderIds: selectedOrderIds,
  note,
});
```

Then refresh:

```txt
Etsy Scale list
Etsy QC list
Etsy Scale statistics
Etsy QC statistics
```

### Update Item Quantity

Use on Etsy order detail/item row:

```ts
await api.patch(`/api/etsy-orders/${orderId}/items/${transactionId}/quantity`, {
  quantity,
});
```

Then refresh:

```txt
Etsy order detail/list row
numberOfItems display
base cost indicators if FE depends on quantity
```

### Open Case

Use when attaching cases to an Etsy order:

```ts
await api.put("/api/etsy-orders/open-case", {
  orderId,
  caseIds,
});
```

Then refresh:

```txt
Etsy order detail/list case badges
case panel if visible
```

### Remove Case

Use when detaching cases from an Etsy order:

```ts
await api.put("/api/etsy-orders/remove-case", {
  orderId,
  caseIds,
});
```

Then refresh:

```txt
Etsy order detail/list case badges
case panel if visible
```

## Implementation References

Backend controller:

```txt
src/controllers/etsyOrder.controller.js
```

Backend routes:

```txt
src/routes/etsyOrder.routes.js
```

Focused tests:

```txt
src/controllers/__tests__/etsyOrder.resetBaseCost.test.js
```
