#!/usr/bin/env node
require("dotenv").config();

const { MongoClient } = require("mongodb");
const {
  round2,
  calcAmazonOrderProfit,
} = require("../src/utils/amazonFinance");

const arg = (name, fallback = null) => {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return fallback;
  const next = process.argv[idx + 1];
  return !next || next.startsWith("--") ? true : next;
};

const compute = (doc) => {
  return calcAmazonOrderProfit({
    finance: doc.amazon_finance_total,
    baseCost: doc.base_cost,
  });
};

(async () => {
  const uri = arg("uri", process.env.MONGO_URI);
  const dbName = arg("db", process.env.DB_NAME);
  const from = arg("from", "2026-07-01");
  const limit = Number(arg("limit", 20));
  const update = process.argv.includes("--update");

  if (!uri || !dbName) throw new Error("Missing MONGO_URI/DB_NAME or --uri/--db");

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const col = client.db(dbName).collection("ordercustomproducts");
    const match = {
      purchase_date: { $gte: new Date(`${from}T00:00:00.000Z`) },
      amazon_finance_total: { $exists: true, $ne: null },
    };
    const cursor = col.find(match, {
      projection: {
        orderId: 1,
        purchase_date: 1,
        base_cost: 1,
        amazon_finance_total: 1,
      },
    });

    let scanned = 0;
    let wouldUpdate = 0;
    const samples = [];
    const ops = [];

    for await (const doc of cursor) {
      scanned += 1;
      const next = compute(doc);
      const f = doc.amazon_finance_total || {};
      const changed =
        round2(f.revenue) !== next.revenue ||
        round2(f.fee) !== next.fee ||
        round2(f.profit1) !== next.profit1 ||
        round2(f.profit2) !== next.profit2;

      if (!changed) continue;
      wouldUpdate += 1;

      if (samples.length < limit) {
        samples.push({
          orderId: doc.orderId,
          purchase_date: doc.purchase_date,
          old: {
            revenue: round2(f.revenue),
            fee: round2(f.fee),
            profit1: round2(f.profit1),
            profit2: round2(f.profit2),
          },
          next: {
            revenue: next.revenue,
            fee: next.fee,
            profit1: next.profit1,
            profit2: next.profit2,
          },
        });
      }

      if (update) {
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set: {
                "amazon_finance_total.revenue": next.revenue,
                "amazon_finance_total.fee": next.fee,
                "amazon_finance_total.profit1": next.profit1,
                "amazon_finance_total.profit2": next.profit2,
                "amazon_finance_total.computed_at": new Date(),
              },
            },
          },
        });
      }
    }

    let bulk = null;
    if (ops.length) bulk = await col.bulkWrite(ops, { ordered: false });

    console.log(JSON.stringify({ mode: update ? "update" : "dry-run", from, scanned, wouldUpdate, updated: bulk?.modifiedCount || 0, samples }, null, 2));
  } finally {
    await client.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
