const loadEnv = require("../src/config/env.config");

loadEnv();

const mongoose = require("mongoose");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const COLLECTION_NAME = "orderproducshopify";

async function main() {
  const apply = process.argv.includes("--apply");
  const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/auth_demo";
  const options = {};
  if (process.env.DB_NAME) options.dbName = process.env.DB_NAME;

  await mongoose.connect(mongoURI, options);
  const collection = mongoose.connection.db.collection(COLLECTION_NAME);

  const mappings = [
    ["New", "new"],
    ["Shipped", "ready_for_fulfillment"],
    ["Cancelled", "cancelled"],
  ];

  const counts = [];
  for (const [from, to] of mappings) {
    counts.push({
      from,
      to,
      count: await collection.countDocuments({ processStatus: from }),
    });
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", collection: COLLECTION_NAME, counts }, null, 2));

  if (!apply) {
    console.log("Dry-run only. Re-run with --apply to update DB.");
    await mongoose.disconnect();
    return;
  }

  for (const [from, to] of mappings) {
    const result = await collection.updateMany(
      { processStatus: from },
      {
        $set: {
          processStatus: to,
          statusRollbackAt: new Date(),
        },
      }
    );
    console.log(JSON.stringify({ from, to, matched: result.matchedCount, modified: result.modifiedCount }, null, 2));
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
