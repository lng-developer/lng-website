# Production Gate Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QC approval stop at `Ready`, and make `Push Production` the only normal path from ready orders to production/vendor handling.

**Architecture:** Keep existing controllers. Add one `Case.blocksProduction` flag and one local production-gate check in `qc.controller.js`; remove direct vendor send from `scale.controller.js` approval.

**Tech Stack:** Node.js, Express, Mongoose, Jest.

## Global Constraints

- Do not add dependencies.
- Do not redesign case workflow; removing a case still means resolving it.
- Production push accepts only `Ready` and `Failed`.
- Blocking cases prevent production push.

---

### Task 1: Case Schema

**Files:**
- Modify: `src/models/case.model.js`

**Interfaces:**
- Produces: `Case.blocksProduction: Boolean`

- [ ] Add `blocksProduction` with default `false`.
- [ ] Keep existing case CRUD compatible.

### Task 2: QC Approval Stops At Ready

**Files:**
- Modify: `src/controllers/scale.controller.js`
- Modify tests: `src/controllers/__tests__/scale.lifecycle.test.js`

**Interfaces:**
- Consumes: `computeOverallScaleStatus(order)`
- Produces: approval response with `order_scale_overall_status: "Ready"` when all items are complete.

- [ ] Remove `FulfillmentService.send()` from `confirmScaleForItem`.
- [ ] Keep invalid address guard.
- [ ] Keep provider retry endpoint unchanged.
- [ ] Update tests so final approval does not call vendor send.

### Task 3: Production Gate

**Files:**
- Modify: `src/controllers/qc.controller.js`
- Modify tests: `src/controllers/__tests__/qc.sendToFulfillment.test.js`

**Interfaces:**
- Consumes: populated `order.case` and existing push payload builder.
- Produces: `409` when any case has `blocksProduction: true`.

- [ ] Populate cases with `name blocksProduction` in `pushPlatformOrders`.
- [ ] Reject push when any order has blocking case.
- [ ] Keep `Ready`/`Failed` status gate unchanged.
- [ ] Add one Jest check for blocking cases.

### Task 4: Verify

**Files:**
- Test only.

- [ ] Run `npm test -- --runInBand src/controllers/__tests__/scale.lifecycle.test.js src/controllers/__tests__/qc.sendToFulfillment.test.js`.
- [ ] Run `git diff --check`.
