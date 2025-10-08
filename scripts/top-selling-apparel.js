#!/usr/bin/env node
/**
 * Top Selling Apparel (Product Type + Color + Size)
 * ---------------------------------------------------------------
 * npm i mongodb dotenv
 *
 * .env:
 *   MONGODB_URI=...
 *   DB_NAME=lng_db
 *   COLLECTION=Order
 *
 * Example:
 *   node scripts/top-selling-apparel.js --from 2025-09-01 --to 2025-10-03 --limit 20 --csv ./top_apparel.csv
 */

const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

// ====== CLI ARGS PARSER ======
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [key, valRaw] = a.split("=");
    const k = key.replace(/^--/, "");
    if (valRaw !== undefined) {
      args[k] = valRaw;
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[k] = next;
        i++;
      } else {
        args[k] = true;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv);

// ====== ENV ======
const MONGODB_URI = process.env.MONGO_URI || "";
const DB_NAME = process.env.DB_NAME || "lng_db";
const COLLECTION = process.env.COLLECTION || "ordercustomproducts";
if (!MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI in .env");
  process.exit(1);
}

// ====== Options ======
const FROM = args.from || null;
const TO = args.to || null;
const SELLER_ID = args.sellerId || null;
const SHOP_ID = args.shopId || null;
const LIMIT = Number(args.limit || 20);
const STATUS_EXCLUDE = (args.statusExclude || "Canceled,Refunded")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const CSV_PATH = args.csv || null;

// ====== Helpers ======
function toISODateOrNull(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function toObjectIdOrNull(s) {
  if (!s) return null;
  try { return new ObjectId(s); } catch { return null; }
}
function pad(str, len) {
  str = String(str ?? "");
  if (str.length >= len) return str;
  return str + " ".repeat(len - str.length);
}

// ====== Build Pipeline ======
function buildPipeline({ from, to, sellerId, shopId, limit, statusExclude }) {
  const match = {};
  if (statusExclude && statusExclude.length) {
    match.status = { $nin: statusExclude };
  }

  const fromDate = toISODateOrNull(from);
  const toDate = toISODateOrNull(to);
  if (fromDate || toDate) {
    match.purchase_date = {};
    if (fromDate) match.purchase_date.$gte = fromDate;
    if (toDate) match.purchase_date.$lte = toDate;
  }

  const sellerObjId = toObjectIdOrNull(sellerId);
  if (sellerObjId) match.sellerId = sellerObjId;
  const shopObjId = toObjectIdOrNull(shopId);
  if (shopObjId) match.shopId = shopObjId;

  return [
    { $match: match },
    { $unwind: "$items" },
    {
      $match: {
        "items.version3Data.customizationInfo.surfaces": { $type: "array", $ne: [] }
      }
    },
    { $unwind: "$items.version3Data.customizationInfo.surfaces" },
    {
      $addFields: {
        _areas: "$items.version3Data.customizationInfo.surfaces.areas",
        _qty: { $ifNull: ["$items.quantity", 1] }
      }
    },
    {
      $addFields: {
        productType: {
          $let: {
            vars: {
              hit: {
                $first: {
                  $filter: {
                    input: "$_areas",
                    as: "a",
                    cond: {
                      $and: [
                        { $eq: ["$$a.customizationType", "Options"] },
                        { $regexMatch: { input: "$$a.label", regex: "Select Product Type", options: "i" } }
                      ]
                    }
                  }
                }
              }
            },
            in: { $ifNull: ["$$hit.optionValue", null] }
          }
        },
        color: {
          $let: {
            vars: {
              hit: {
                $first: {
                  $filter: {
                    input: "$_areas",
                    as: "a",
                    cond: {
                      $and: [
                        { $eq: ["$$a.customizationType", "Options"] },
                        { $regexMatch: { input: "$$a.label", regex: "^Color$", options: "i" } }
                      ]
                    }
                  }
                }
              }
            },
            in: { $ifNull: ["$$hit.optionValue", null] }
          }
        },
        size: {
          $let: {
            vars: {
              hit: {
                $first: {
                  $filter: {
                    input: "$_areas",
                    as: "a",
                    cond: {
                      $and: [
                        { $eq: ["$$a.customizationType", "Options"] },
                        { $regexMatch: { input: "$$a.label", regex: "Select Size", options: "i" } }
                      ]
                    }
                  }
                }
              }
            },
            in: { $ifNull: ["$$hit.optionValue", null] }
          }
        }
      }
    },
    { $match: { productType: { $ne: null }, color: { $ne: null }, size: { $ne: null } } },
    {
      $group: {
        _id: { productType: "$productType", color: "$color", size: "$size" },
        totalQty: { $sum: "$_qty" }
      }
    },
    { $sort: { totalQty: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        productType: "$_id.productType",
        color: "$_id.color",
        size: "$_id.size",
        totalSold: "$totalQty"
      }
    }
  ];
}

// ====== CSV ======
function toCSV(rows) {
  const headers = ["productType", "color", "size", "totalSold"];
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  if (!rows || !rows.length) return headers.join(",") + "\n";
  return [
    headers.join(","),
    ...rows.map(r => headers.map(h => esc(r[h])).join(","))
  ].join("\n");
}

// ====== Main ======
(async () => {
  const client = new MongoClient(MONGODB_URI, { ignoreUndefined: true });
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const col = db.collection(COLLECTION);

    const pipeline = buildPipeline({
      from: FROM,
      to: TO,
      sellerId: SELLER_ID,
      shopId: SHOP_ID,
      limit: LIMIT,
      statusExclude: STATUS_EXCLUDE
    });

    const results = await col.aggregate(pipeline, { allowDiskUse: true }).toArray();
    if (!results.length) {
      console.log("No results.");
      process.exit(0);
    }

    // Console table
    const cols = { productType: 30, color: 25, size: 10, totalSold: 10 };
    const header =
      pad("Product Type", cols.productType) +
      pad("Color", cols.color) +
      pad("Size", cols.size) +
      pad("Total Sold", cols.totalSold);
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of results) {
      console.log(
        pad(r.productType, cols.productType) +
        pad(r.color, cols.color) +
        pad(r.size, cols.size) +
        pad(r.totalSold, cols.totalSold)
      );
    }

    // Export CSV
    if (CSV_PATH) {
      const out = toCSV(results);
      const abs = path.resolve(process.cwd(), CSV_PATH);
      fs.writeFileSync(abs, out, "utf8");
      console.log(`\n✅ CSV saved: ${abs}`);
    }
  } catch (err) {
    console.error("❌ Error:", err?.message || err);
    process.exit(1);
  } finally {
    await client.close();
  }
})();
