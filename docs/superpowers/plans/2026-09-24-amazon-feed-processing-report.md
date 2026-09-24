# Amazon Feed Processing Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Mark tracking successful only after Amazon's Processing Report is stored and reconciled.

**Architecture:** The extension submits with the native Seller Central form and retains a read-only feed-history watch. It reports lifecycle events through the authenticated socket. The backend validates machine ownership, stores audit evidence on ShippingBatch, and the portal displays it.

**Tech Stack:** Chrome MV3, Socket.IO, Express, Mongoose, React/Vite.

**Spec:** docs/superpowers/specs/2026-09-24-amazon-feed-processing-report-design.md

## Global Constraints

- Never resubmit or retry an Amazon feed automatically.
- Use existing Seller Central UI and extension socket; add no dependency.
- done requires processed and activated counts equal submitted rows and error count equals zero.
- Store full report text and SHA-256 digest.
- Close the dedicated tab only after backend acknowledges a terminal result.

## Review Focus

- Another machine cannot write a batch it does not own; Task 2 tests this.
- Duplicate events do not regress a final result; Task 1 tests this.
- Done with errors or a count mismatch cannot become done; Task 1 tests this.
- Worker restart resumes polling but never submits again; Task 3 tests this.
- Report download requires portal authentication; Task 2 tests this.

---

### Task 1: Reconciliation model and service

**Files:**
- Modify: C:\lng-web-v1\lng-website\src\models\shippingBatch.model.js:56-104
- Create: C:\lng-web-v1\lng-website\src\service\amazonFeedReconciliation.service.js
- Test: C:\lng-web-v1\lng-website\src\service\amazonFeedReconciliation.service.test.js

**Interfaces:**
- Consumes: status, amazonBatchId, record counts, reportText, failureReason, and completed row count.
- Produces: reconcileAmazonFeed({ current, expectedRows, event }) returning accepted, next, terminal.

- [ ] **Step 1: Write failing state tests**

~~~js
expect(reconcileAmazonFeed({ current: {}, expectedRows: 1, event: {
  status: "done", amazonBatchId: "93703020720", recordsProcessed: 1,
  recordsActivated: 1, errorCount: 0, warningCount: 0, reportText: "ok"
} }).next.status).toBe("done");

expect(reconcileAmazonFeed({ current: {}, expectedRows: 1, event: {
  status: "done", recordsProcessed: 1, recordsActivated: 0, errorCount: 1
} }).next.status).toBe("failed");
~~~

- [ ] **Step 2: Run failing test**

Run: npm test -- --runInBand src/service/amazonFeedReconciliation.service.test.js

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement minimal schema and pure service**

~~~js
const AmazonFeedSchema = new mongoose.Schema({
  amazonBatchId: String,
  status: { type: String, enum: ["submitted", "processing", "done", "failed", "needs_review"] },
  submittedAt: Date, completedAt: Date,
  recordsProcessed: Number, recordsActivated: Number,
  errorCount: Number, warningCount: Number,
  reportText: String, reportSha256: String, failureReason: String,
}, { _id: false });
~~~

Add the schema to ShippingBatch. Implement only forward transitions submitted → processing → done|failed|needs_review. An exact repeat returns the stored result; a changed Amazon Batch ID is rejected. Compute reportSha256 with Node crypto. Map a Done count mismatch without Amazon errors to needs_review.

- [ ] **Step 4: Run focused tests**

Run: npm test -- --runInBand src/service/amazonFeedReconciliation.service.test.js

Expected: PASS for done, failed, needs_review, invalid transition, and duplicate event.

- [ ] **Step 5: Commit**

~~~bash
git add src/models/shippingBatch.model.js src/service/amazonFeedReconciliation.service.js src/service/amazonFeedReconciliation.service.test.js
git commit -m "feat(tracking): persist Amazon feed reconciliation"
~~~

### Task 2: Socket ingestion and report download

**Files:**
- Modify: C:\lng-web-v1\lng-website\src\socket\index.js:130-190
- Modify: C:\lng-web-v1\lng-website\src\controllers\shippingBatch.contrller.js:1332-1555,2292-2301
- Modify: C:\lng-web-v1\lng-website\src\routes\shippingBatch.routes.js:18-61
- Test: C:\lng-web-v1\lng-website\src\socket\amazonFeedStatus.socket.test.js
- Test: C:\lng-web-v1\lng-website\src\controllers\__tests__\shippingBatch.amazonFeedReport.test.js

**Interfaces:**
- Consumes: socket client:amazon_feed_status plus socket.data.machineId.
- Produces: ShippingBatch.amazonFeed, shop amazon_feed:status event, and GET /api/shipping-batch/:batchId/amazon-feed-report.

- [ ] **Step 1: Write failing authorization and persistence tests**

~~~js
await handler({ batchId, machineId: "forged", status: "processing" }, ack);
expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));

await request(app)
  .get("/api/shipping-batch/" + batchId + "/amazon-feed-report")
  .expect(401);
~~~

Also assert valid terminal input stores report text and digest, returns terminal acknowledgement, and emits a shop-scoped update.

- [ ] **Step 2: Run failing tests**

Run: npm test -- --runInBand src/socket/amazonFeedStatus.socket.test.js src/controllers/__tests__/shippingBatch.amazonFeedReport.test.js

Expected: FAIL because the event and route do not exist.

- [ ] **Step 3: Implement one trusted socket handler and one protected read route**

~~~js
socket.on("client:amazon_feed_status", async (payload = {}, ack) => {
  const result = await applyAmazonFeedStatus({
    batchId: payload.batchId, machineId: socket.data.machineId,
    shopId: socket.data.shopId, event: payload,
  });
  io.to("shop:" + socket.data.shopId).emit("amazon_feed:status", result.publicBatch);
  ack?.({ ok: true, status: result.status });
});
~~~

The handler requires batch.machineId to equal the socket identity, calls Task 1's service, and saves only accepted events. The route uses authenticateToken, returns 404 when no report exists, otherwise sends text/plain as an attachment.

- [ ] **Step 4: Run focused tests**

Run: npm test -- --runInBand src/socket/amazonFeedStatus.socket.test.js src/controllers/__tests__/shippingBatch.amazonFeedReport.test.js

Expected: PASS for machine binding, duplicate events, terminal persistence, auth, and attachment.

- [ ] **Step 5: Commit**

~~~bash
git add src/socket/index.js src/controllers/shippingBatch.contrller.js src/routes/shippingBatch.routes.js src/socket/amazonFeedStatus.socket.test.js src/controllers/__tests__/shippingBatch.amazonFeedReport.test.js
git commit -m "feat(tracking): ingest Amazon processing reports"
~~~

### Task 3: Extension watch and portal result

**Files:**
- Create: C:\lng_system\lng-web\Amazon-Extension\lib\amazon-feed-history.js
- Create: C:\lng_system\lng-web\Amazon-Extension\test\amazon-feed-history.test.mjs
- Modify: C:\lng_system\lng-web\Amazon-Extension\background.js:3930-4315,5503-5765
- Modify: C:\lng-web-v1\LNG\src\apis\shippingBatch.js:1-20
- Modify: C:\lng-web-v1\LNG\src\pages\home\checkoder\checkoder.jsx:450-550,1110-1220
- Test: C:\lng-web-v1\LNG\src\pages\home\checkoder\checkoder.test.jsx

**Interfaces:**
- Consumes: parseFeedHistoryRows(html), parseProcessingReport(text), and stored watch { batchId, expectedRows, sellerCentralTabId }.
- Produces: status events, terminal tab closure, portal status and report-download control.

- [ ] **Step 1: Write failing parser, resume, and UI tests**

~~~js
assert.deepEqual(parseFeedHistoryRows(html), [{
  amazonBatchId: "93703020720", status: "Done", reportHref: "/report"
}]);
assert.equal(parseProcessingReport(reportText).recordsActivated, 1);
assert.equal(nextWatchState({ amazonBatchId: "93703020720" }, { status: "Done" }).terminal, true);
~~~

In the portal test, render a done feed and assert Amazon: Done · 1/1 activated and button Tải Processing Report. Click it and assert downloadAmazonFeedReport receives the batch ID.

- [ ] **Step 2: Run failing tests**

Run: node --test test/amazon-feed-history.test.mjs in C:\lng_system\lng-web\Amazon-Extension

Run: npm test -- --runInBand src/pages/home/checkoder/checkoder.test.jsx in C:\lng-web-v1\LNG

Expected: FAIL because parser, watch, and UI do not exist.

- [ ] **Step 3: Implement the read-only watcher and concise portal status**

~~~js
export function parseFeedHistoryRows(html) { /* Batch ID, status, report link */ }
export function parseProcessingReport(text) { /* processed, activated, errors, warnings */ }
~~~

Before native submission snapshot history IDs. After submission persist the watch and emit submitted. Every 30 seconds read only the Seller Central history. At Done fetch View Processing Report in that logged-in tab, parse it, and emit raw report text. Restore watches after worker restart; restored watches only poll. Wait for backend terminal acknowledgement before tab removal. Do not report task completed at native form submission.

Add Axios blob download and render Submitted/Processing pending, Done success, Failed/Needs review actionable. Do not add another send control.

- [ ] **Step 4: Run verification**

Run: node --test test/amazon-feed-history.test.mjs; node --check background.js; git diff --check in C:\lng_system\lng-web\Amazon-Extension

Run: npm test -- --runInBand src/pages/home/checkoder/checkoder.test.jsx; npm run lint; npm run build in C:\lng-web-v1\LNG

Expected: PASS.

- [ ] **Step 5: Commit per repository**

~~~bash
# Amazon-Extension
git add background.js lib/amazon-feed-history.js test/amazon-feed-history.test.mjs
git commit -m "feat(tracking): poll Amazon processing reports"

# LNG
git add src/apis/shippingBatch.js src/pages/home/checkoder/checkoder.jsx src/pages/home/checkoder/checkoder.test.jsx
git commit -m "feat(tracking): show Amazon feed reconciliation"
~~~

### Task 4: Safe live verification

**Files:**
- Modify: no source files expected.

- [ ] **Step 1: Run all changed unit tests**

Run backend reconciliation/socket/controller tests, extension parser tests, then portal lint and build.

Expected: PASS.

- [ ] **Step 2: Read the existing completed Amazon row only**

Use Batch ID 93703020720. Confirm backend stores done, processed 1, activated 1, errors 0, warnings 0, and report text. Do not submit a file.

- [ ] **Step 3: Verify portal evidence**

Download the retained report from the portal. Confirm its SHA-256 digest equals stored reportSha256 and status is Done.

- [ ] **Step 4: Record release evidence**

Record deployed revisions and health checks. Do not create a verification commit unless operational instructions change.

