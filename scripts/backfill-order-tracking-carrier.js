const mongoose = require("mongoose");

function carrierFromNote(note) {
  const parts = String(note || "")
    .split("|")
    .map(part => part.trim())
    .reverse();
  const carrierPart = parts.find(part => /^carrier:/i.test(part));
  return carrierPart ? carrierPart.replace(/^carrier:/i, "").trim() : "";
}

async function main() {
  const loadEnv = require("../src/config/env.config");
  loadEnv();
  const apply = process.argv.includes("--apply");
  const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/auth_demo";
  const options = { serverSelectionTimeoutMS: 10000 };
  if (process.env.DB_NAME) options.dbName = process.env.DB_NAME;
  await mongoose.connect(mongoURI, options);

  const collection = mongoose.connection.db.collection("ordercustomproducts");
  const cursor = collection.find({
    "items.tracking_info.carrier": { $in: [null, ""] },
    "items.tracking_info.note": /(?:^|\|)\s*carrier:/i,
  }, { projection: { orderId: 1, items: 1 }, maxTimeMS: 15000 });

  const operations = [];
  const samples = [];
  let candidates = 0;
  while (await cursor.hasNext()) {
    const order = await cursor.next();
    (order.items || []).forEach((item, index) => {
      const carrier = carrierFromNote(item?.tracking_info?.note);
      if (!carrier || item?.tracking_info?.carrier) return;
      candidates++;
      if (samples.length < 10) samples.push({ orderId: order.orderId, orderItemId: item.orderItemId || null, carrier });
      operations.push({
        updateOne: {
          filter: { _id: order._id, [`items.${index}.tracking_info.carrier`]: { $in: [null, ""] } },
          update: { $set: { [`items.${index}.tracking_info.carrier`]: carrier } },
        },
      });
    });
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates, samples }, null, 2));
  if (apply && operations.length) {
    const result = await collection.bulkWrite(operations, { ordered: false });
    console.log(JSON.stringify({ matched: result.matchedCount, modified: result.modifiedCount }, null, 2));
  } else if (!apply) {
    console.log("Dry-run only. Re-run with --apply to write carrier fields.");
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { carrierFromNote };
