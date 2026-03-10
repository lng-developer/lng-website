// scripts/merchize.syncTracking.js
// Usage:
//   node scripts/merchize.syncTracking.js one <amazonOrderId> [--debug]
//   node scripts/merchize.syncTracking.js list <id1> <id2> ...
//   node scripts/merchize.syncTracking.js batch [--scope vendor|guess|all] [--since-days 30] [--max 200] [--dry-run] [--debug]

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const axios = require("axios").default;

// ====== Models ======
const db = require("../src/models");
const OrderCustomProduct = db.orderCustomProduct;

// ====== ENV ======
const {
    MONGO_URI = "mongodb://127.0.0.1:27017/lng",
    NODE_ENV = "development",
    MERCHIZE_ACCESS_TOKEN = "", // đã có trong .env của bạn
} = process.env;

const argv = process.argv.slice(2);
const getFlagVal = (name, def = undefined) => {
    const i = argv.indexOf(name);
    if (i === -1) return def;
    const v = argv[i + 1];
    return !v || v.startsWith("--") ? def : v;
};
const hasFlag = (name) => argv.includes(name);
const DEBUG = hasFlag("--debug");

// ====== Helpers ======
const norm = (s) => String(s || "").trim();

const http = axios.create({
    baseURL: "https://bo-group-1-2.merchize.com/403c7ev/bo-api",
    timeout: 20000,
    headers: {
        Authorization: `Bearer ${MERCHIZE_ACCESS_TOKEN}`,
        Accept: "application/json",
    },
});

// gọi API Merchize
// gọi API Merchize (ưu tiên tracking, fallback order-detail)
async function apiGetDetailByAmazonId(orderId) {
    const trackingUrl = `/order/external/orders/tracking`;
    const detailUrl = `/order/external/orders/order-detail`;

    // 1) Ưu tiên gọi tracking
    let res = await http.get(trackingUrl, {
        params: { external_number: orderId },
        validateStatus: () => true,
    });
    if (DEBUG) console.log("[Merchize][HTTP tracking]", res.status, "| keys:", Object.keys(res.data || {}));

    if (res.status >= 400) {
        throw new Error(`Merchize HTTP ${res.status} (tracking) for ${orderId}`);
    }
    if (res.data?.success === true && Array.isArray(res.data.data) && res.data.data.length > 0) {
        return res.data.data[0];
    }

    // 2) Fallback sang order-detail nếu tracking rỗng
    res = await http.get(detailUrl, {
        params: { external_number: orderId },
        validateStatus: () => true,
    });
    if (DEBUG) console.log("[Merchize][HTTP detail]", res.status, "| keys:", Object.keys(res.data || {}));

    if (res.status >= 400) {
        throw new Error(`Merchize HTTP ${res.status} (detail) for ${orderId}`);
    }
    if (res.data?.success === true && Array.isArray(res.data.data) && res.data.data.length > 0) {
        return res.data.data[0];
    }

    throw new Error(`Merchize found no data for external_number=${orderId} (tracking & detail both empty)`);
}
async function updateOrderFromMerchize(orderId) {
    const doc = await OrderCustomProduct.findOne({ orderId: orderId.trim() });
    if (!doc) throw new Error(`Order not found in DB: ${orderId}`);

    const data = await apiGetDetailByAmazonId(orderId);

    const trackingNumber = norm(data?.tracking_number);
    const carrier = norm(data?.tracking_company);
    const statusFromVendor = norm(data?.status).toLowerCase();
    const shipped = statusFromVendor === "fulfilled" || Boolean(trackingNumber);

    let changed = 0;
    doc.items = doc.items.map((it) => {
        const ti = it.tracking_info || {};
        const prevTracking = norm(ti.tracking);
        const prevStatus = norm(ti.status);

        const nextTI = {
            ...ti,
            fulfillment: "Merchize",
            tracking: trackingNumber || prevTracking,
            status: shipped ? "Shipped" : prevStatus || "New",
            updated_at: new Date(),
            note: [ti.note, carrier].filter(Boolean).join(" | "),
        };

        if (
            nextTI.tracking !== prevTracking ||
            nextTI.status !== prevStatus ||
            nextTI.fulfillment !== ti.fulfillment
        ) {
            changed++;
        }
        return { ...(it.toObject?.() ? it.toObject() : it), tracking_info: nextTI };
    });

    const allShipped = doc.items.every(
        (it) => norm(it?.tracking_info?.status).toLowerCase() === "shipped"
    );
    let orderStatusChanged = false;
    if (allShipped && doc.status !== "Shipped") {
        doc.status = "Shipped";
        orderStatusChanged = true;
    }

    doc.merchize_submission = {
        ...(doc.merchize_submission || {}),
        attempt_count: (doc.merchize_submission?.attempt_count || 0) + 1,
        last_response: data,
    };

    await doc.save();
    return { updatedItems: changed, tracking: trackingNumber, orderStatusChanged };
}

// ====== Batch ======
function buildBatchQuery({ scope = "vendor", sinceDays, max = 100 }) {
    const base = { status: { $ne: "Shipped" } };
    const q = { ...base };

    if (scope === "vendor") {
        q.$or = [
            { "items.tracking_info.fulfillment": "Merchize" },
            { "merchize_submission": { $exists: true } },
        ];
    } else if (scope === "guess") {
        const days = Number(sinceDays ?? 30);
        const since = new Date(Date.now() - days * 86400 * 1000);
        q.$or = [
            { purchase_date: { $gte: since } },
            { purchase_date: null, createdAt: { $gte: since } },
        ];
    } else if (scope === "all") {
        // tất cả đơn chưa Shipped
    }
    return { q, max };
}

async function runBatch() {
    const scope = getFlagVal("--scope", "vendor"); // vendor | guess | all
    const sinceDays = getFlagVal("--since-days", undefined);
    const max = Number(getFlagVal("--max", "100"));
    const dryRun = hasFlag("--dry-run");

    const { q, max: limit } = buildBatchQuery({ scope, sinceDays, max });
    if (DEBUG) console.log("[BATCH][QUERY]", JSON.stringify(q));

    const candidates = await OrderCustomProduct.find(q)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    if (dryRun) {
        console.log(
            JSON.stringify(
                {
                    ok: true,
                    mode: "dry-run",
                    scope,
                    sinceDays,
                    scanned: candidates.length,
                    orderIds: candidates.map((o) => o.orderId),
                },
                null,
                2
            )
        );
        return { ok: true, fail: 0, scanned: candidates.length };
    }

    let ok = 0,
        fail = 0;
    for (const o of candidates) {
        try {
            const res = await updateOrderFromMerchize(o.orderId);
            if (DEBUG || NODE_ENV !== "test") {
                console.log(
                    `[OK] ${o.orderId} | itemsChanged=${res.updatedItems} | tracking=${res.tracking} | orderStatusChanged=${res.orderStatusChanged}`
                );
            }
            ok++;
        } catch (err) {
            console.error(`[FAIL] ${o.orderId}:`, err.message);
            fail++;
        }
    }
    return { ok, fail, scanned: candidates.length };
}

// ====== CLI Entrypoint ======
(async () => {
    try {
        await mongoose.connect(MONGO_URI, {});
        const { host, name } = mongoose.connection;
        console.log(`[DB] connected: ${host}/${name}`);

        const mode = argv[0];
        if (mode === "one") {
            const orderId = argv[1];
            if (!orderId)
                throw new Error(
                    `Usage: node scripts/merchize.syncTracking.js one <amazonOrderId> [--debug]`
                );
            const res = await updateOrderFromMerchize(orderId);
            console.log(JSON.stringify({ ok: true, orderId, ...res }, null, 2));
        } else if (mode === "list") {
            const ids = argv.slice(1).filter((v) => !v.startsWith("--"));
            if (!ids.length)
                throw new Error(
                    `Usage: node scripts/merchize.syncTracking.js list <id1> <id2> ... [--debug]`
                );
            let ok = 0,
                fail = 0;
            for (const id of ids) {
                try {
                    const r = await updateOrderFromMerchize(id);
                    console.log(
                        `[OK] ${id} => tracking=${r.tracking}, orderStatusChanged=${r.orderStatusChanged}`
                    );
                    ok++;
                } catch (err) {
                    console.error(`[FAIL] ${id}:`, err.message);
                    fail++;
                }
            }
            console.log(JSON.stringify({ ok, fail, scanned: ids.length }, null, 2));
        } else if (mode === "batch") {
            const r = await runBatch();
            console.log(JSON.stringify(r, null, 2));
        } else {
            console.log(
                `Usage:
  node scripts/merchize.syncTracking.js one <amazonOrderId> [--debug]
  node scripts/merchize.syncTracking.js list <id1> <id2> ... [--debug]
  node scripts/merchize.syncTracking.js batch [--scope vendor|guess|all] [--since-days 30] [--max 200] [--dry-run] [--debug]`
            );
        }
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close().catch(() => { });
    }
})();
