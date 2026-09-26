const { reconcileAmazonFeed } = require("./amazonFeedReconciliation.service");
const { finalizeAmazonConfirmation } = require("./amazonConfirmationReservation.service");

function createStatusError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function applyAmazonFeedStatus({ ShippingBatch, OrderModel, batchId, machineId, event }) {
  if (!ShippingBatch || !batchId || !machineId) {
    throw createStatusError("INVALID_INPUT", "batchId and machineId are required");
  }

  const batch = await ShippingBatch.findById(batchId);
  if (!batch) throw createStatusError("BATCH_NOT_FOUND", "Shipping batch not found");
  if (String(batch.machineId) !== String(machineId)) {
    throw createStatusError("MACHINE_MISMATCH", "Extension machine does not own this shipping batch");
  }

  const result = reconcileAmazonFeed({
    current: batch.amazonFeed || {},
    expectedRows: Array.isArray(batch.completed) ? batch.completed.length : 0,
    event,
  });
  if (!result.accepted) {
    throw createStatusError(result.reason || "STATUS_REJECTED", "Amazon feed status was rejected");
  }

  if (!result.duplicate) {
    batch.amazonFeed = result.next;
    await batch.save();
  }
  if (result.terminal && OrderModel && batch.shopId) {
    const state = result.next.status === "done" ? "confirmed" : result.next.status;
    const transitions = await Promise.all((batch.completed || []).map((item) => finalizeAmazonConfirmation({
      OrderModel,
      orderId: item.orderId,
      shopId: batch.shopId,
      batchId: batch._id,
      state,
      amazonBatchId: result.next.amazonBatchId,
    })));
    if (transitions.some(({ finalized }) => !finalized)) {
      throw createStatusError("ORDER_FINALIZATION_REJECTED", "Amazon feed was stored but an order confirmation could not be finalized");
    }
  }
  return {
    batchId: String(batch._id),
    status: result.next.status,
    terminal: result.terminal,
    amazonFeed: result.next,
  };
}

module.exports = { applyAmazonFeedStatus };
