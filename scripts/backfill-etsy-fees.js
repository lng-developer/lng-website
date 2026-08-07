const { calculateEtsyEstimatedFee } = require("../src/helper/etsyFee");

const BACKFILL_FROM = new Date("2026-08-01T00:00:00.000Z");
const ELIGIBLE_ORDERS = {
  saleDate: { $gte: BACKFILL_FROM },
  "totals.orderTotal": { $gt: 0 },
  $or: [
    { "totals.fee": { $exists: false } },
    { "totals.fee": null },
    { "totals.fee": 0 },
  ],
};

const backfillEtsyFees = async ({ collection, apply = false, logger = console.log }) => {
  const orders = await collection.find(ELIGIBLE_ORDERS, {
    projection: { orderId: 1, totals: 1 },
  }).toArray();
  const updates = [];

  for (const order of orders) {
    const revenue = Number(order?.totals?.orderTotal) || 0;
    const currentFee = Number(order?.totals?.fee) || 0;
    const calculatedFee = calculateEtsyEstimatedFee({
      orderTotal: revenue,
      salesTax: order?.totals?.salesTax,
    });
    if (calculatedFee === currentFee) continue;

    logger(JSON.stringify({
      orderId: order.orderId,
      revenue,
      currentFee,
      calculatedFee,
      difference: Number((calculatedFee - currentFee).toFixed(2)),
    }));
    updates.push({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { "totals.fee": calculatedFee } },
      },
    });
  }

  let written = 0;
  if (apply && updates.length) {
    written = (await collection.bulkWrite(updates)).modifiedCount || 0;
  }

  return { matched: orders.length, changed: updates.length, written };
};

const main = async () => {
  require("../src/config/env.config")();
  const mongoose = require("mongoose");
  const apply = process.argv.slice(2).includes("--apply");

  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.DB_NAME });
  try {
    const summary = await backfillEtsyFees({
      collection: mongoose.connection.collection("etsyorders"),
      apply,
    });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }));
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { BACKFILL_FROM, ELIGIBLE_ORDERS, backfillEtsyFees };
