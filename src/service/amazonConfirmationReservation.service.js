function identityFilter({ orderId, shopId, batchId }) {
  return {
    orderId,
    shopId,
    "amazonConfirmation.batchId": batchId,
  };
}

async function reserveAmazonConfirmation({ OrderModel, orderId, shopId, batchId, now = new Date() }) {
  const order = await OrderModel.findOneAndUpdate(
    {
      orderId,
      shopId,
      $or: [
        { "amazonConfirmation.state": { $exists: false } },
        { "amazonConfirmation.state": null },
      ],
    },
    {
      $set: {
        "amazonConfirmation.state": "reserved",
        "amazonConfirmation.batchId": batchId,
        "amazonConfirmation.amazonBatchId": "",
        "amazonConfirmation.reservedAt": now,
        "amazonConfirmation.submittedAt": null,
        "amazonConfirmation.finalizedAt": null,
      },
    },
    { new: true },
  );

  return { reserved: Boolean(order), order: order || null };
}

async function releaseAmazonConfirmationReservation({ OrderModel, orderId, shopId, batchId }) {
  const result = await OrderModel.updateOne(
    { ...identityFilter({ orderId, shopId, batchId }), "amazonConfirmation.state": "reserved" },
    { $unset: { amazonConfirmation: 1 } },
  );
  return result.modifiedCount === 1;
}

async function markAmazonConfirmationSubmitted({ OrderModel, orderId, shopId, batchId, now = new Date() }) {
  const order = await OrderModel.findOneAndUpdate(
    { ...identityFilter({ orderId, shopId, batchId }), "amazonConfirmation.state": "reserved" },
    {
      $set: {
        "amazonConfirmation.state": "submitted",
        "amazonConfirmation.submittedAt": now,
      },
    },
    { new: true },
  );
  return { submitted: Boolean(order), order: order || null };
}

async function finalizeAmazonConfirmation({ OrderModel, orderId, shopId, batchId, state, amazonBatchId = "", now = new Date() }) {
  if (!["confirmed", "needs_review", "failed"].includes(state)) {
    throw new Error("Invalid Amazon confirmation terminal state");
  }
  const order = await OrderModel.findOneAndUpdate(
    { ...identityFilter({ orderId, shopId, batchId }), "amazonConfirmation.state": "submitted" },
    {
      $set: {
        "amazonConfirmation.state": state,
        "amazonConfirmation.amazonBatchId": amazonBatchId,
        "amazonConfirmation.finalizedAt": now,
      },
    },
    { new: true },
  );
  return { finalized: Boolean(order), order: order || null };
}

module.exports = {
  finalizeAmazonConfirmation,
  markAmazonConfirmationSubmitted,
  releaseAmazonConfirmationReservation,
  reserveAmazonConfirmation,
};
