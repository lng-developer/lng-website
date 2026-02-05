#!/usr/bin/env node
/**
 * findCnlNoCostBreakdown.js
 *
 * Điều kiện:
 *  - items.sku CONTAINS "CNL"
 *  - items.cost_breakdown IS NULL OR MISSING
 *  - createdAt từ 30/01 đến hiện tại
 *
 * Chạy:
 *  node findCnlNoCostBreakdown.js \
 *    --uri="mongodb://127.0.0.1:27017" \
 *    --db="lng" \
 *    --col="OrderCustomProduct" \
 *    --out="./result.json"
 */

const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

/* -------------------- CONFIG -------------------- */
const FROM_DATE = new Date("2026-01-30T00:00:00.000Z"); // 30/01
const TO_DATE = new Date(); // hết hôm nay (thời điểm chạy)
/* ------------------------------------------------ */

function parseArgs(argv) {
    const args = {};
    for (const a of argv.slice(2)) {
        if (!a.startsWith("--")) continue;
        const [k, ...rest] = a.slice(2).split("=");
        args[k] = rest.join("=");
    }
    return args;
}

function escapeCsv(val) {
    if (val === null || val === undefined) return "";
    const s = String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

(async function main() {
    const args = parseArgs(process.argv);

    const uri = "mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net?retryWrites=true&w=majority&appName=LNGWeb"
    const dbName = "lng_db"
    const colName = "OrderCustomProduct";
    const outFile = args.out;

    if (!uri || !dbName) {
        console.error("❌ Thiếu --uri hoặc --db");
        process.exit(1);
    }

    const client = new MongoClient(uri, {
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 15000,
    });

    try {
        await client.connect();
        const col = client.db(dbName).collection(colName);

        /* ---------------- AGGREGATION PIPELINE ---------------- */
        const pipeline = [
            // 1️⃣ Lọc theo thời gian
            {
                $match: {
                    createdAt: {
                        $gte: FROM_DATE,
                        $lt: TO_DATE,
                    },
                },
            },

            // 2️⃣ Order có ít nhất 1 item CNL & thiếu cost_breakdown
            {
                $match: {
                    items: {
                        $elemMatch: {
                            sku: { $regex: /CNL/i },
                            $or: [
                                { cost_breakdown: null },
                                { cost_breakdown: { $exists: false } },
                            ],
                        },
                    },
                },
            },

            // 3️⃣ Bung items
            { $unwind: "$items" },

            // 4️⃣ Lọc chính xác item thỏa điều kiện
            {
                $match: {
                    "items.sku": { $regex: /CNL/i },
                    $or: [
                        { "items.cost_breakdown": null },
                        { "items.cost_breakdown": { $exists: false } },
                    ],
                },
            },

            // 5️⃣ Output gọn – đúng thứ cần xử lý
            {
                $project: {
                    _id: 0,
                    orderId: 1,
                    orderItemId: "$items.orderItemId",
                    sku: "$items.sku",
                    createdAt: 1,
                    purchase_date: 1,
                    status: 1,
                    shopId: 1,
                    sellerId: 1,
                },
            },

            { $sort: { createdAt: -1 } },
        ];
        /* ------------------------------------------------------ */

        const results = await col.aggregate(pipeline, {
            allowDiskUse: true,
        }).toArray();

        console.log(`✅ Found ${results.length} item(s)`);
        console.table(results.slice(0, 50));

        /* -------------------- EXPORT -------------------- */
        if (outFile && results.length) {
            const ext = path.extname(outFile).toLowerCase();

            if (ext === ".json") {
                fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");
                console.log("📁 Saved JSON:", outFile);
            } else if (ext === ".csv") {
                const headers = Object.keys(results[0]);
                const rows = [
                    headers.join(","),
                    ...results.map((r) =>
                        headers.map((h) => escapeCsv(r[h])).join(",")
                    ),
                ];
                fs.writeFileSync(outFile, rows.join("\n"), "utf8");
                console.log("📁 Saved CSV:", outFile);
            } else {
                console.warn("⚠️ Chỉ hỗ trợ export .json hoặc .csv");
            }
        }
    } catch (err) {
        console.error("❌ ERROR:", err);
    } finally {
        await client.close();
    }
})();
