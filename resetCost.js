#!/usr/bin/env node
/**
 * backfill-profits-ocp.js
 *
 * Collection: ordercustomproducts
 * Fields cập nhật trong amazon_finance_total:
 *  - opCost:  default 0 (nếu thiếu)
 *  - refund:  default 0 (nếu thiếu)
 *  - profit1: revenue - (base_cost + fee)
 *  - profit2: revenue - (base_cost + fee + opCost + refund)
 *
 * revenue/fee: ưu tiên lấy từ amazon_finance_total, nếu thiếu sẽ fallback sang field ở root.
 * Mọi giá trị được ép kiểu với $convert (onError=0, onNull=0) để tránh lỗi kiểu dữ liệu.
 *
 * Cách chạy (Git Bash):
 *   npm i mongodb                       # cài driver 1 lần
 *
 *   # Dry-run (xem trước, KHÔNG ghi), xem tối đa 20 doc
 *   node backfill-profits-ocp.js --uri "mongodb://localhost:27017/lng_db" --dry-run --limit 20
 *
 *   # Update thật
 *   node backfill-profits-ocp.js --uri "mongodb://localhost:27017/lng_db" --update
 *
 * Tuỳ chọn:
 *   --collection ordercustomproducts     (mặc định)
 *   --only-missing true|false            (mặc định true: chỉ doc thiếu trường mới)
 *   --db lng_db                          (nếu URI không kèm dbName)
 */

const { MongoClient } = require("mongodb");

// ---------- helpers ----------
function getFlag(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
function toInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function parseDbNameFromUri(u) {
  if (!u) return null;
  const m = u.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)(?:\?.*)?$/i);
  return m ? m[1] : null;
}

// ---------- CLI ----------
const uri = getFlag("uri") || process.env.MONGODB_URI;
const dbFromFlag = getFlag("db") || process.env.DB_NAME || null;
const collection = getFlag("collection") || "ordercustomproducts";

const isDryRun = hasFlag("dry-run") || !hasFlag("update"); // mặc định dry-run
const isUpdate = hasFlag("update");
const onlyMissing =
  (getFlag("only-missing") ?? "true").toString().toLowerCase() !== "false";
const limit = toInt(getFlag("limit") ?? 20, 20);

const dbName = dbFromFlag || parseDbNameFromUri(uri);

if (!uri) {
  console.error("❌ Missing --uri or MONGODB_URI");
  process.exit(1);
}
if (!dbName) {
  console.error(
    "❌ Database name not found. Provide via --db or include it in URI (…/lng_db)"
  );
  process.exit(1);
}

// ---------- match ----------
const matchBase = { amazon_finance_total: { $exists: true } };
const onlyMissingMatch = {
  $or: [
    { "amazon_finance_total.profit1": { $exists: false } },
    { "amazon_finance_total.profit2": { $exists: false } },
    { "amazon_finance_total.opCost": { $exists: false } },
  ],
};
const match = onlyMissing ? { ...matchBase, ...onlyMissingMatch } : matchBase;

// ---------- pipelines ----------
const dryRunPipeline = (limitN) => [
  { $match: match },

  // Chuẩn hoá và ép kiểu
  {
    $set: {
      _opCost: {
        $convert: {
          input: "$amazon_finance_total.opCost",
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _refund: {
        $convert: {
          input: "$amazon_finance_total.refund",
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _rev: {
        $convert: {
          input: { $ifNull: ["$amazon_finance_total.revenue", "$revenue"] },
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _fee: {
        $convert: {
          input: { $ifNull: ["$amazon_finance_total.fee", "$fee"] },
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _base: {
        $convert: { input: "$base_cost", to: "double", onError: 0, onNull: 0 },
      },
    },
  },

  // Tính toán
  {
    $set: {
      new_profit1: {
        $round: [{ $subtract: ["$_rev", { $add: ["$_base", "$_fee"] }] }, 2],
      },
      new_profit2: {
        $round: [
          {
            $subtract: [
              "$_rev",
              { $add: ["$_base", "$_fee", "$_opCost", "$_refund"] },
            ],
          },
          2,
        ],
      },
    },
  },

  // Chỉ hiển thị những doc sẽ thay đổi
  {
    $addFields: {
      changed: {
        $or: [
          { $ne: ["$amazon_finance_total.opCost", "$_opCost"] },
          { $ne: ["$amazon_finance_total.refund", "$_refund"] },
          { $ne: ["$amazon_finance_total.profit1", "$new_profit1"] },
          { $ne: ["$amazon_finance_total.profit2", "$new_profit2"] },
        ],
      },
    },
  },
  { $match: { changed: true } },

  // Preview
  {
    $project: {
      _id: 1,
      orderId: 1,
      base_cost: 1,
      revenue_root: "$revenue",
      fee_root: "$fee",
      revenue_aft: "$amazon_finance_total.revenue",
      fee_aft: "$amazon_finance_total.fee",
      inputs_used: {
        rev: "$_rev",
        fee: "$_fee",
        base: "$_base",
        opCost: "$_opCost",
        refund: "$_refund",
      },
      old: {
        opCost: "$amazon_finance_total.opCost",
        refund: "$amazon_finance_total.refund",
        profit1: "$amazon_finance_total.profit1",
        profit2: "$amazon_finance_total.profit2",
      },
      set: {
        "amazon_finance_total.opCost": "$_opCost",
        "amazon_finance_total.refund": "$_refund",
        "amazon_finance_total.profit1": "$new_profit1",
        "amazon_finance_total.profit2": "$new_profit2",
      },
    },
  },
  { $limit: limitN },
];

const countWouldUpdatePipeline = [
  { $match: match },
  {
    $set: {
      _opCost: {
        $convert: {
          input: "$amazon_finance_total.opCost",
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _refund: {
        $convert: {
          input: "$amazon_finance_total.refund",
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _rev: {
        $convert: {
          input: { $ifNull: ["$amazon_finance_total.revenue", "$revenue"] },
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _fee: {
        $convert: {
          input: { $ifNull: ["$amazon_finance_total.fee", "$fee"] },
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
      _base: {
        $convert: { input: "$base_cost", to: "double", onError: 0, onNull: 0 },
      },
    },
  },
  {
    $set: {
      new_profit1: {
        $round: [{ $subtract: ["$_rev", { $add: ["$_base", "$_fee"] }] }, 2],
      },
      new_profit2: {
        $round: [
          {
            $subtract: [
              "$_rev",
              { $add: ["$_base", "$_fee", "$_opCost", "$_refund"] },
            ],
          },
          2,
        ],
      },
    },
  },
  {
    $addFields: {
      changed: {
        $or: [
          { $ne: ["$amazon_finance_total.opCost", "$_opCost"] },
          { $ne: ["$amazon_finance_total.refund", "$_refund"] },
          { $ne: ["$amazon_finance_total.profit1", "$new_profit1"] },
          { $ne: ["$amazon_finance_total.profit2", "$new_profit2"] },
        ],
      },
    },
  },
  { $match: { changed: true } },
  { $count: "would_update" },
];

const updatePipeline = [
  // Defaults nếu thiếu
  {
    $set: {
      "amazon_finance_total.opCost": {
        $ifNull: ["$amazon_finance_total.opCost", 0],
      },
      "amazon_finance_total.refund": {
        $ifNull: ["$amazon_finance_total.refund", 0],
      },
    },
  },

  // profit1 = revenue - (base_cost + fee)
  {
    $set: {
      "amazon_finance_total.profit1": {
        $round: [
          {
            $subtract: [
              {
                $convert: {
                  input: {
                    $ifNull: ["$amazon_finance_total.revenue", "$revenue"],
                  },
                  to: "double",
                  onError: 0,
                  onNull: 0,
                },
              },
              {
                $add: [
                  {
                    $convert: {
                      input: "$base_cost",
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                  {
                    $convert: {
                      input: { $ifNull: ["$amazon_finance_total.fee", "$fee"] },
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                ],
              },
            ],
          },
          2,
        ],
      },
    },
  },

  // profit2 = revenue - (base_cost + fee + opCost + refund)
  {
    $set: {
      "amazon_finance_total.profit2": {
        $round: [
          {
            $subtract: [
              {
                $convert: {
                  input: {
                    $ifNull: ["$amazon_finance_total.revenue", "$revenue"],
                  },
                  to: "double",
                  onError: 0,
                  onNull: 0,
                },
              },
              {
                $add: [
                  {
                    $convert: {
                      input: "$base_cost",
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                  {
                    $convert: {
                      input: { $ifNull: ["$amazon_finance_total.fee", "$fee"] },
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                  {
                    $convert: {
                      input: "$amazon_finance_total.opCost",
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                  {
                    $convert: {
                      input: "$amazon_finance_total.refund",
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                ],
              },
            ],
          },
          2,
        ],
      },
      "amazon_finance_total.computed_at": "$$NOW",
    },
  },
];

// ---------- main ----------
(async () => {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    const col = db.collection(collection);

    console.log(`🔗 Connected: DB=${dbName}  COL=${collection}`);
    console.log(
      `🔎 onlyMissing=${onlyMissing}  mode=${isDryRun ? "dry-run" : "update"}`
    );

    if (isDryRun) {
      const preview = await col
        .aggregate(dryRunPipeline(limit), { allowDiskUse: true })
        .toArray();
      const countArr = await col
        .aggregate(countWouldUpdatePipeline, { allowDiskUse: true })
        .toArray();
      const would = countArr?.[0]?.would_update || 0;

      console.log(
        `📊 Would update: ${would} document(s). Preview (up to ${limit}):`
      );
      for (const d of preview) console.log(JSON.stringify(d, null, 2));
      console.log("✅ Dry-run finished.");
      process.exit(0);
    }

    if (isUpdate) {
      const result = await col.updateMany(match, updatePipeline);
      console.log("✅ Update done:", {
        acknowledged: result.acknowledged,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedCount: result.upsertedCount,
      });
      process.exit(0);
    }
  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  } finally {
    try {
      await client.close();
    } catch {}
  }
})();
