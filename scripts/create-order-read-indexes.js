const loadEnv = require("../src/config/env.config");

loadEnv();

const mongoose = require("mongoose");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const ORDER_INDEXES = [
  [{ purchase_date: -1 }],
  [{ status: 1, purchase_date: -1 }],
  [{ sellerId: 1, purchase_date: -1 }],
  [{ shopId: 1, purchase_date: -1 }],
  [{ base_cost: 1, status: 1, purchase_date: -1 }],
  [{ shipping_type: 1, purchase_date: -1 }],
  [{ "address_validation.isValid": 1, purchase_date: -1 }],
];

const ETSY_INDEXES = [
  [{ status: 1, saleDate: -1 }],
  [{ shopId: 1, saleDate: -1 }],
  [{ "seller.sellerId": 1, saleDate: -1 }],
  [{ base_cost: 1, status: 1, saleDate: -1 }],
  [{ shipping_type: 1, saleDate: -1 }],
  [{ "address_validation.isValid": 1, saleDate: -1 }],
];

async function createIndexes(collection, indexes) {
  for (const [keys] of indexes) {
    const name = await collection.createIndex(keys, { background: true });
    console.log(`${collection.collectionName}: ${name}`);
  }
}

async function main() {
  const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/auth_demo";
  const options = {};
  if (process.env.DB_NAME) options.dbName = process.env.DB_NAME;

  await mongoose.connect(mongoURI, options);
  const db = mongoose.connection.db;

  await createIndexes(db.collection("ordercustomproducts"), ORDER_INDEXES);
  await createIndexes(db.collection("etsyorders"), ETSY_INDEXES);

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
