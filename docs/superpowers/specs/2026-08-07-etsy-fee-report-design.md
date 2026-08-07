# Etsy Fee Report Design

## Goal

Remove the unexplained `revenue * 21.5%` Etsy report override and make imports, historical backfill, and reports use one estimated-fee calculation.

## Scope

- Add one shared Etsy estimated-fee function using the existing Vietnam formula.
- Use it when importing Etsy Sold Orders.
- Make the Etsy seller report use the fee stored on each order.
- Add a standalone backfill command that defaults to dry-run and updates only orders whose `totals.fee` is missing or zero when explicitly applied.
- Add focused tests for the shared calculation, report behavior, and dry-run/apply selection.

Importing actual Etsy Payment Account fees is excluded from this change. The stored value remains an estimate until that separate reconciliation flow exists.

## Calculation

For USD orders:

```text
taxExclusiveTotal = max(0, orderTotal - salesTax)
fee = 6.5% * taxExclusiveTotal
    + 4.5% * orderTotal
    + 11,500 VND / exchangeRate
    + 1.24% * taxExclusiveTotal
```

The default exchange rate remains `26,000 VND/USD` to preserve current behavior. The helper accepts an exchange-rate argument so a future caller can supply a current rate without duplicating the formula.

Invalid, negative, or absent numeric inputs are treated as zero. The result is rounded to two decimal places.

## Data flow

1. Etsy Sold Orders import calculates and persists `totals.fee` through the shared helper.
2. The seller report aggregates `etsy_finance_total.fee` when present, otherwise `totals.fee`, without replacing it with a revenue percentage.
3. The backfill reads eligible orders, prints `orderId`, revenue, current fee, calculated fee, and difference, and makes no writes unless `--apply` is passed.
4. Apply mode updates only `totals.fee`; it does not alter revenue, tax, costs, seller assignment, status, or fulfillment data.

## Safety and verification

- Backfill is dry-run by default.
- Apply mode requires the explicit `--apply` flag.
- The query is limited to Etsy orders with missing/zero `totals.fee` and a positive `totals.orderTotal`.
- Unit tests lock the sample calculation and ensure reports consume aggregated fee rather than `21.5%` of revenue.
- Focused Jest tests run before the full suite.

