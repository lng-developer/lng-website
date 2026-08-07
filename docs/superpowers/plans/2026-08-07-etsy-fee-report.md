# Etsy Fee Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Etsy report's unexplained 21.5% fee with the stored Vietnam fee estimate and safely backfill missing historical fees.

**Architecture:** A small pure helper owns the existing Vietnam fee formula. Import and backfill call that helper; reporting only aggregates the persisted fee, preserving `etsy_finance_total.fee` precedence. A standalone script defaults to read-only dry-run and requires `--apply` to write.

**Tech Stack:** Node.js CommonJS, Mongoose, Jest.

## Global Constraints

- Preserve the existing Vietnam rates: 6.5%, 4.5% plus 11,500 VND, and 1.24%.
- Preserve the default exchange rate of 26,000 VND/USD while allowing an explicit helper argument.
- Do not add dependencies.
- Do not import Etsy Payment Account data in this change.
- Backfill must make no writes unless `--apply` is present.
- Apply mode may update only `totals.fee` on eligible Etsy orders.

---

### Task 1: Shared Etsy fee calculation

**Files:**
- Create: `src/helper/etsyFee.js`
- Create: `src/helper/__tests__/etsyFee.test.js`

**Interfaces:**
- Produces: `calculateEtsyEstimatedFee({ orderTotal, salesTax, exchangeRate = 26000 }): number`.

- [ ] **Step 1: Write the failing helper test**

```js
const { calculateEtsyEstimatedFee } = require("../etsyFee");

test("calculates the Vietnam Etsy fee for order 4067362471", () => {
  expect(calculateEtsyEstimatedFee({ orderTotal: 53.38, salesTax: 3.02 })).toBe(6.74);
});

test("does not produce negative or non-finite fees", () => {
  expect(calculateEtsyEstimatedFee({ orderTotal: -1, salesTax: 3 })).toBe(0);
  expect(calculateEtsyEstimatedFee({ orderTotal: "bad", salesTax: null })).toBe(0);
});
```

- [ ] **Step 2: Run the helper test and verify RED**

Run: `npm test -- --runInBand src/helper/__tests__/etsyFee.test.js`

Expected: FAIL because `../etsyFee` does not exist.

- [ ] **Step 3: Implement the minimum pure helper**

```js
const DEFAULT_VND_PER_USD = 26000;

const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const calculateEtsyEstimatedFee = ({ orderTotal, salesTax, exchangeRate = DEFAULT_VND_PER_USD } = {}) => {
  const total = money(orderTotal);
  if (!total) return 0;
  const taxExclusiveTotal = Math.max(0, total - money(salesTax));
  const rate = money(exchangeRate) || DEFAULT_VND_PER_USD;
  const fee = 0.065 * taxExclusiveTotal + 0.045 * total + 11500 / rate + 0.0124 * taxExclusiveTotal;
  return Number(fee.toFixed(2));
};

module.exports = { DEFAULT_VND_PER_USD, calculateEtsyEstimatedFee };
```

- [ ] **Step 4: Run the helper test and verify GREEN**

Run: `npm test -- --runInBand src/helper/__tests__/etsyFee.test.js`

Expected: 2 tests pass.

- [ ] **Step 5: Commit the helper**

```powershell
git add src/helper/etsyFee.js src/helper/__tests__/etsyFee.test.js
git commit -m "fix(finance): centralize Etsy fee estimate"
```

### Task 2: Import and report use the persisted fee

**Files:**
- Modify: `src/controllers/etsyOrder.controller.js:1033-1062`
- Modify: `src/controllers/etsyReport.controller.js:270-275`
- Modify: `src/controllers/__tests__/etsyOrder.importOrdersAutoCompute.test.js`
- Create: `src/controllers/__tests__/etsyReport.fee.test.js`

**Interfaces:**
- Consumes: `calculateEtsyEstimatedFee({ orderTotal, salesTax }): number`.
- Produces: imported `totals.fee`; report fee equal to aggregated `r.fee`.

- [ ] **Step 1: Add a failing import assertion**

After invoking `importOrders`, inspect the `bulkWrite` operation and assert:

```js
expect(db.EtsyOrder.bulkWrite.mock.calls[0][0][0].updateOne.update.$set["totals.fee"]).toBe(1.67);
```

Use the existing `$10` order fixture; the shared formula produces `$1.67` at the default exchange rate.

- [ ] **Step 2: Add a failing report regression test**

Mock the Etsy order aggregation row with `revenue: 40.86`, `fee: 5.26`, and all other costs zero. Invoke `getEtsyReportMatrix` as an admin and assert:

```js
expect(res.json.mock.calls[0][0].data["Nguyễn Đức Sơn (Bé)"].fee).toEqual([5.26]);
expect(res.json.mock.calls[0][0].data["Nguyễn Đức Sơn (Bé)"].profit1).toEqual([35.60]);
```

- [ ] **Step 3: Run both controller tests and verify RED**

Run: `npm test -- --runInBand src/controllers/__tests__/etsyOrder.importOrdersAutoCompute.test.js src/controllers/__tests__/etsyReport.fee.test.js`

Expected: import assertion fails until the helper is wired in; report assertion receives `$8.78` because of the 21.5% override.

- [ ] **Step 4: Wire the helper into import and remove the report override**

In `etsyOrder.controller.js`, replace the inline fee calculation with:

```js
const calculatedFee = calculateEtsyEstimatedFee({ orderTotal, salesTax });
```

Persist `calculatedFee` directly. In `etsyReport.controller.js`, replace the override with:

```js
S.fee[idx] = +(r.fee || 0).toFixed(2);
```

- [ ] **Step 5: Run both controller tests and verify GREEN**

Run: `npm test -- --runInBand src/controllers/__tests__/etsyOrder.importOrdersAutoCompute.test.js src/controllers/__tests__/etsyReport.fee.test.js`

Expected: all selected tests pass.

- [ ] **Step 6: Commit import and report behavior**

```powershell
git add src/controllers/etsyOrder.controller.js src/controllers/etsyReport.controller.js src/controllers/__tests__/etsyOrder.importOrdersAutoCompute.test.js src/controllers/__tests__/etsyReport.fee.test.js
git commit -m "fix(finance): use stored Etsy fees in reports"
```

### Task 3: Safe historical backfill

**Files:**
- Create: `scripts/backfill-etsy-fees.js`
- Create: `scripts/__tests__/backfill-etsy-fees.test.js`

**Interfaces:**
- Consumes: `calculateEtsyEstimatedFee` and a Mongoose collection.
- Produces: `backfillEtsyFees({ collection, apply, logger }): Promise<{ matched, changed, written }>`; CLI flag `--apply`.

- [ ] **Step 1: Write failing dry-run and apply tests**

Use a fake collection returning one order with `orderTotal: 53.38`, `salesTax: 3.02`, and `fee: 0`. Assert dry-run reports `{ matched: 1, changed: 1, written: 0 }` without calling `bulkWrite`; assert apply mode calls `bulkWrite` once with `$set: { "totals.fee": 6.74 }`.

- [ ] **Step 2: Run the script test and verify RED**

Run: `npm test -- --runInBand scripts/__tests__/backfill-etsy-fees.test.js`

Expected: FAIL because `backfill-etsy-fees.js` does not exist.

- [ ] **Step 3: Implement dry-run-default backfill**

Query only:

```js
{
  "totals.orderTotal": { $gt: 0 },
  $or: [
    { "totals.fee": { $exists: false } },
    { "totals.fee": null },
    { "totals.fee": 0 },
  ],
}
```

Print one JSON line per changed order containing `orderId`, `revenue`, `currentFee`, `calculatedFee`, and `difference`. Accumulate updates but call `bulkWrite` only when `apply === true`. Load environment and connect only inside `if (require.main === module)` so Jest can import the function without connecting.

- [ ] **Step 4: Run the script test and verify GREEN**

Run: `npm test -- --runInBand scripts/__tests__/backfill-etsy-fees.test.js`

Expected: dry-run and apply tests pass.

- [ ] **Step 5: Run a live dry-run without DB writes**

Run: `node scripts/backfill-etsy-fees.js`

Expected: summary has `written: 0`; output includes order `4067362471` with calculated fee `$6.74` when it remains eligible.

- [ ] **Step 6: Commit the backfill**

```powershell
git add scripts/backfill-etsy-fees.js scripts/__tests__/backfill-etsy-fees.test.js
git commit -m "fix(finance): add safe Etsy fee backfill"
```

### Task 4: Final verification

**Files:**
- Verify only; no production file changes expected.

**Interfaces:**
- Consumes: all deliverables from Tasks 1-3.
- Produces: test and diff evidence for handoff.

- [ ] **Step 1: Run focused tests**

Run: `npm test -- --runInBand src/helper/__tests__/etsyFee.test.js src/controllers/__tests__/etsyOrder.importOrdersAutoCompute.test.js src/controllers/__tests__/etsyReport.fee.test.js scripts/__tests__/backfill-etsy-fees.test.js`

Expected: all selected suites pass.

- [ ] **Step 2: Run the full Jest suite**

Run: `npm test -- --runInBand`

Expected: all suites pass with zero failures.

- [ ] **Step 3: Check patch hygiene**

Run: `git diff --check HEAD~3..HEAD; git status --short`

Expected: no whitespace errors; only intentional uncommitted plan/documentation changes, if any.

- [ ] **Step 4: Recheck J2610 without writing**

Run the existing report path or an equivalent read-only aggregation for employee `J2610` on `2026-08-07`. Confirm the report uses the stored/backfilled fee and separately flag any order whose `base_cost` remains zero.

