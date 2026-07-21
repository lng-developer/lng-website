const loadEnv = require("../src/config/env.config");

loadEnv();

const mongoose = require("mongoose");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const COLLECTION_NAME = "orderproducshopify";

const cancellationPredicates = [
  { processStatus: { $in: ["Cancelled", "cancelled", "Canceled", "canceled"] } },
  { "rawShopifyOrder.cancelled_at": { $exists: true, $nin: [null, ""] } },
];

const trackingPredicates = [
  { "trackingInfo.trackingNumber": { $exists: true, $nin: [null, ""] } },
  { "trackingInfo.trackingUrl": { $exists: true, $nin: [null, ""] } },
  { "rawShopifyOrder.fulfillments.tracking_number": { $exists: true, $nin: [null, ""] } },
  { "rawShopifyOrder.fulfillments.tracking_url": { $exists: true, $nin: [null, ""] } },
  { "rawShopifyOrder.fulfillments.tracking_numbers": { $exists: true, $ne: [] } },
  { "rawShopifyOrder.fulfillments.tracking_urls": { $exists: true, $ne: [] } },
];

const cancelledFilter = { $or: cancellationPredicates };
const shippedFilter = {
  $and: [
    { $nor: cancellationPredicates },
    { $or: trackingPredicates },
  ],
};
const newFilter = {
  $and: [
    { $nor: cancellationPredicates },
    { $nor: trackingPredicates },
  ],
};

async function countTarget(collection, status, filter) {
  const total = await collection.countDocuments(filter);
  const already = await collection.countDocuments({
    $and: [filter, { processStatus: status }],
  });

  return {
    target: status,
    total,
    already,
    toUpdate: total - already,
  };
}

async function sampleChanges(collection, status, filter) {
  return collection
    .find({
      $and: [filter, { processStatus: { $ne: status } }],
    })
    .project({
      _id: 1,
      shopifyOrderId: 1,
      shopifyOrderName: 1,
      processStatus: 1,
      fulfillmentStatus: 1,
      "trackingInfo.trackingNumber": 1,
      "rawShopifyOrder.cancelled_at": 1,
    })
    .limit(5)
    .toArray();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/auth_demo";
  const options = {};
  if (process.env.DB_NAME) options.dbName = process.env.DB_NAME;

  await mongoose.connect(mongoURI, options);
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);

  const targets = [
    ["Cancelled", cancelledFilter],
    ["Shipped", shippedFilter],
    ["New", newFilter],
  ];

  const counts = [];
  for (const [status, filter] of targets) {
    counts.push(await countTarget(collection, status, filter));
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", collection: COLLECTION_NAME, counts }, null, 2));

  for (const [status, filter] of targets) {
    const samples = await sampleChanges(collection, status, filter);
    if (samples.length) {
      console.log(JSON.stringify({ target: status, sampleChanges: samples }, null, 2));
    }
  }

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to update DB.");
    await mongoose.disconnect();
    return;
  }

  for (const [status, filter] of targets) {
    const result = await collection.updateMany(filter, {
      $set: {
        processStatus: status,
        statusMigratedAt: new Date(),
      },
    });
    console.log(JSON.stringify({ target: status, matched: result.matchedCount, modified: result.modifiedCount }, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
