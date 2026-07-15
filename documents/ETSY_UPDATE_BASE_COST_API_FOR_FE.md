# Etsy Update Base Cost API For FE

Use this API when FE needs to manually set the base cost of one Etsy order.

Base API prefix:

```txt
/api/etsy
```

This endpoint requires the same bearer token auth flow as other protected Etsy order actions.

## Endpoint

```http
PUT /api/etsy/update-base-cost
```

## Request Body

```json
{
  "orderId": "ETSY_ORDER_ID",
  "base_cost": 12.5
}
```

## Request Fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `orderId` | `string` | Yes | Etsy order ID in the backend order document. |
| `base_cost` | `number` | Yes | Must be a positive number greater than `0`. Do not send as string. |

## Success Response

```json
{
  "message": "Etsy order base cost updated successfully",
  "orderId": "ETSY_ORDER_ID",
  "newBaseCost": 12.5
}
```

## Backend Behavior

The API updates only:

```txt
base_cost = request.body.base_cost
```

If the value changes, backend also writes:

```txt
OrderHistory.action = UPDATE_BASE_COST
Lifecycle event = ORDER_BASE_COST_UPDATED
```

This manual update does not clear:

```txt
base_cost_shipping_groups
base_cost_computed_at
items[].cost_breakdown
```

If FE needs to clear computed cost data before recalculation, use:

```http
PUT /api/etsy/reset-base-cost
```

## FE Integration Example

```ts
await api.put("/api/etsy/update-base-cost", {
  orderId,
  base_cost: Number(baseCostInput),
});
```

After success, refresh:

```txt
Etsy order detail
Etsy order list row
Base cost/no-cost indicators
Any report or summary widget that displays base cost
```

## Error Responses

Missing `orderId` or `base_cost`:

```json
{
  "message": "Missing orderId or base cost"
}
```

Invalid `base_cost`:

```json
{
  "message": "Base Cost must be a positive number"
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
  "message": "Failed to update Etsy order base cost",
  "error": "..."
}
```

## FE Validation Notes

- Convert the input to a number before sending.
- Reject empty, zero, negative, and non-numeric values on FE before calling the API.
- Keep the key name exactly `base_cost`.
- Use the response `newBaseCost` to update local UI optimistically, then refresh from backend when possible.

## Backend References

```txt
src/routes/etsyOrder.routes.js
src/controllers/etsyOrder.controller.js
src/controllers/__tests__/etsyOrder.resetBaseCost.test.js
```
