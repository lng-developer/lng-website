# Amazon Shipping Confirmation: Processing Report Reconciliation

## Purpose

Make Amazon's Processing Report the source of truth for a tracking-upload
batch. A successful click of Seller Central's **Upload now** button means only
that Amazon accepted the file for processing; it must not mark orders as sent.

The extension obtains the final Amazon report and sends it to the backend. The
backend persists the audit evidence and exposes the final result to the portal.

## Scope

Included:

- Native Seller Central upload submission already used by `UPLOAD_TRACKING`.
- Discovering the Amazon feed Batch ID from the upload-history table.
- Read-only polling of that table until it is terminal.
- Fetching and retaining the Processing Report text for a `Done` feed.
- Persisting and displaying batch-level reconciliation status.

Excluded:

- Retrying or resubmitting a feed automatically.
- Changing the submitted TSV mapping or carrier selection.
- Reprocessing historical Amazon batches created outside LNG.

## State model

`ShippingBatch.amazonFeed` is the authoritative state for Amazon processing.

| State | Meaning | Terminal |
| --- | --- | --- |
| `submitted` | Extension submitted the file; Amazon Batch ID may not yet be visible. | No |
| `processing` | Amazon upload-history row is `In Progress`. | No |
| `done` | Report was retrieved and every submitted row was activated with zero errors. | Yes |
| `failed` | Amazon reports errors, an unrecoverable retrieval failure, or reconciliation mismatch. | Yes |
| `needs_review` | Amazon finished but report cannot prove the submitted rows were all activated. | Yes |

The existing extension task result records transport progress only. It must not
be interpreted as final Amazon success until `amazonFeed.status` is `done`.

## Data persisted on the batch

```js
amazonFeed: {
  amazonBatchId: String,
  status: String,
  submittedAt: Date,
  completedAt: Date,
  recordsProcessed: Number,
  recordsActivated: Number,
  errorCount: Number,
  warningCount: Number,
  reportText: String,
  reportSha256: String,
  failureReason: String
}
```

`reportText` is stored with the batch so it is available for download and audit
without depending on a browser download folder. Processing reports for this
workflow are small text files; implementation enforces the MongoDB document
limit and rejects an oversized report rather than silently truncating evidence.

## Extension flow

1. Before native upload, read the visible upload-history Batch IDs.
2. Assign the generated TSV to `#fileToUpload`, then submit using the existing
   Seller Central form. Report `submitted` to the backend; do not close the
   dedicated tab.
3. Reload or refresh only the history view every 30 seconds and identify the
   newly-created row, then report its Amazon Batch ID.
4. While the row is `In Progress`, report `processing` idempotently.
5. When the row is `Done`, use its **View Processing Report** action in the
   logged-in Seller Central tab to read the report text. Send report text and
   parsed counts to the backend.
6. Close the dedicated tab only after the backend acknowledges a terminal
   persisted state. On any non-terminal error, leave the tab open for recovery.

The watch is persisted in extension storage, keyed by LNG batch ID. After a
service-worker or browser restart, the extension resumes polling an existing
Amazon Batch ID. It never creates another upload for that batch.

## Backend contract

Add one authenticated extension-only status event/endpoint, conceptually:

```js
{
  batchId,
  machineId,
  status,
  amazonBatchId,
  recordsProcessed,
  recordsActivated,
  errorCount,
  warningCount,
  reportText,
  failureReason
}
```

The backend validates that the batch belongs to `machineId`, permits only
forward state transitions, and treats an identical repeat event as success.
It calculates the report digest server-side. A terminal event updates the
batch and emits the existing realtime update for the portal.

The endpoint/event does not accept arbitrary user-browser calls: it uses the
same authenticated extension identity as the task channel and validates the
batch-to-machine binding before writing.

## Reconciliation rules

For a submitted batch containing `N` rows:

- `done` only when `recordsProcessed === N`, `recordsActivated === N`, and
  `errorCount === 0`.
- `needs_review` when Amazon says `Done` but counts do not prove that rule.
- `failed` when Amazon reports errors, or the extension retrieves an invalid
  report that cannot be parsed.
- warnings remain visible but do not by themselves fail the batch.

No state above triggers another upload. A user chooses a separate retry flow
after examining the retained report.

## Portal behaviour

The shipping review/list displays the Amazon Batch ID and status. A completed
batch offers **Download Processing Report** and shows processed, activated,
errors, and warnings. `submitted` and `processing` remain visibly pending;
they are not labelled as successfully sent to Amazon.

## Verification

- Unit test status transitions, machine/batch authorization, duplicate-event
  idempotency, and the reconciliation rules.
- Extension unit test history-row detection and Processing Report parsing.
- A safe integration test reads the already-completed Amazon batch
  `93703020720`; it must not submit a new feed.
- Verify the portal shows `done`, 1 processed, 1 activated, 0 errors, 0
  warnings, and serves the stored report text.
