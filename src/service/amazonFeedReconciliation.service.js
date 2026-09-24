const crypto = require("crypto");

const TERMINAL_STATUSES = new Set(["done", "failed", "needs_review"]);
const ALLOWED_STATUSES = new Set(["submitted", "processing", ...TERMINAL_STATUSES]);
const MAX_REPORT_BYTES = 14 * 1024 * 1024;

function asCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function digestReport(reportText) {
  return crypto.createHash("sha256").update(reportText, "utf8").digest("hex");
}

function reconcileAmazonFeed({ current = {}, expectedRows, event = {}, now = new Date() }) {
  const status = String(event.status || "").toLowerCase();
  if (!ALLOWED_STATUSES.has(status)) {
    return { accepted: false, terminal: false, reason: "INVALID_STATUS", next: current };
  }

  const amazonBatchId = String(event.amazonBatchId || current.amazonBatchId || "").trim();
  if (!amazonBatchId && status !== "submitted" && status !== "failed") {
    return { accepted: false, terminal: false, reason: "AMAZON_BATCH_ID_REQUIRED", next: current };
  }
  if (current.amazonBatchId && amazonBatchId && current.amazonBatchId !== amazonBatchId) {
    return { accepted: false, terminal: TERMINAL_STATUSES.has(current.status), reason: "AMAZON_BATCH_ID_MISMATCH", next: current };
  }

  const recordsProcessed = asCount(event.recordsProcessed);
  const recordsActivated = asCount(event.recordsActivated);
  const errorCount = asCount(event.errorCount);
  const warningCount = asCount(event.warningCount);
  const reportText = typeof event.reportText === "string" ? event.reportText : current.reportText;
  if (reportText && Buffer.byteLength(reportText, "utf8") > MAX_REPORT_BYTES) {
    return { accepted: false, terminal: false, reason: "PROCESSING_REPORT_TOO_LARGE", next: current };
  }

  const expected = asCount(expectedRows);
  let resolvedStatus = status;
  if (status === "done") {
    resolvedStatus = errorCount > 0
      ? "failed"
      : recordsProcessed === expected && recordsActivated === expected
        ? "done"
        : "needs_review";
  }

  const currentTerminal = TERMINAL_STATUSES.has(current.status);
  if (currentTerminal) {
    const duplicate = current.status === resolvedStatus
      && current.amazonBatchId === amazonBatchId
      && asCount(current.recordsProcessed) === recordsProcessed
      && asCount(current.recordsActivated) === recordsActivated
      && asCount(current.errorCount) === errorCount
      && asCount(current.warningCount) === warningCount
      && (reportText || "") === (current.reportText || "");
    return duplicate
      ? { accepted: true, terminal: true, duplicate: true, next: current }
      : { accepted: false, terminal: true, reason: "TERMINAL_STATUS_IMMUTABLE", next: current };
  }

  if (current.status === "processing" && resolvedStatus === "submitted") {
    return { accepted: false, terminal: false, reason: "STATUS_REGRESSION", next: current };
  }

  const next = {
    ...current,
    amazonBatchId: amazonBatchId || undefined,
    status: resolvedStatus,
    recordsProcessed,
    recordsActivated,
    errorCount,
    warningCount,
    reportText: reportText || undefined,
    reportSha256: reportText ? digestReport(reportText) : undefined,
    failureReason: typeof event.failureReason === "string" ? event.failureReason.slice(0, 1000) : undefined,
  };
  if (!current.submittedAt) next.submittedAt = event.submittedAt ? new Date(event.submittedAt) : now;
  if (TERMINAL_STATUSES.has(resolvedStatus)) next.completedAt = now;

  return { accepted: true, terminal: TERMINAL_STATUSES.has(resolvedStatus), next };
}

module.exports = { reconcileAmazonFeed, MAX_REPORT_BYTES };
