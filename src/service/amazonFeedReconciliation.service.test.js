const { reconcileAmazonFeed } = require("./amazonFeedReconciliation.service");

describe("reconcileAmazonFeed", () => {
  test("marks a complete, error-free Processing Report as done", () => {
    const result = reconcileAmazonFeed({
      current: {},
      expectedRows: 1,
      event: {
        status: "done",
        amazonBatchId: "93703020720",
        recordsProcessed: 1,
        recordsActivated: 1,
        errorCount: 0,
        warningCount: 0,
        reportText: "Number of records that were activated: 1",
      },
    });

    expect(result.next.status).toBe("done");
    expect(result.next.reportSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("marks an Amazon report with errors as failed", () => {
    const result = reconcileAmazonFeed({
      current: {},
      expectedRows: 1,
      event: {
        status: "done",
        amazonBatchId: "93703020720",
        recordsProcessed: 1,
        recordsActivated: 0,
        errorCount: 1,
      },
    });

    expect(result.next.status).toBe("failed");
    expect(result.terminal).toBe(true);
  });

  test("records a submission failure before Amazon assigns a Batch ID", () => {
    const result = reconcileAmazonFeed({
      current: {},
      expectedRows: 1,
      event: { status: "failed", failureReason: "Seller Central session expired" },
    });

    expect(result.next.status).toBe("failed");
    expect(result.next.amazonBatchId).toBeUndefined();
  });

  test("requires review when Done cannot reconcile all submitted rows", () => {
    const result = reconcileAmazonFeed({
      current: {},
      expectedRows: 2,
      event: {
        status: "done",
        amazonBatchId: "93703020720",
        recordsProcessed: 2,
        recordsActivated: 1,
        errorCount: 0,
      },
    });

    expect(result.next.status).toBe("needs_review");
  });

  test("keeps an exact duplicate terminal event idempotent", () => {
    const current = {
      status: "done",
      amazonBatchId: "93703020720",
      recordsProcessed: 1,
      recordsActivated: 1,
      errorCount: 0,
      warningCount: 0,
      reportText: "ok",
      reportSha256: "a".repeat(64),
    };
    const result = reconcileAmazonFeed({
      current,
      expectedRows: 1,
      event: { ...current, status: "done" },
    });

    expect(result.accepted).toBe(true);
    expect(result.next).toEqual(current);
  });
});
