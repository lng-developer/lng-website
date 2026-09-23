const mongoose = require("mongoose");
const loadEnv = require("../src/config/env.config");
const { previewOrderVendorTracking } = require("../src/controllers/ext.controller");

async function main() {
  const orderId = process.argv[2];
  if (!orderId) throw new Error("Usage: node scripts/preview-vendor-tracking.js <order-id>");

  loadEnv();
  const options = { serverSelectionTimeoutMS: 10000 };
  if (process.env.DB_NAME) options.dbName = process.env.DB_NAME;
  await mongoose.connect(process.env.MONGO_URI, options);
  console.log(JSON.stringify(await previewOrderVendorTracking(orderId), null, 2));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
