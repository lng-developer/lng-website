// scripts/merchfox.syncTracking.js
// Usage:
//   node scripts/merchfox.syncTracking.js one <amazonOrderId> [--debug]
//   node scripts/merchfox.syncTracking.js list <id1> <id2> ... [--debug]
//   node scripts/merchfox.syncTracking.js batch [--scope vendor|guess|all] [--since-days 30] [--max 200] [--dry-run] [--debug]
//
// ENV (trong .env ở root project):
//   MONGO_URI=...
//   MERCHFOX_TOKENKEY=...
//   MERCHFOX_SECRET=...

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const axios = require("axios").default;
const qs = require("querystring");

// ====== Models (giữ đúng theo codebase của bạn) ======
const db = require("../src/models");
const OrderCustomProduct = db.orderCustomProduct;

// ====== ENV ======
const {
    MONGO_URI = "mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net/lng_db?retryWrites=true&w=majority&appName=LNGWeb",
    MERCHFOX_TOKENKEY = "",
    MERCHFOX_SECRET = "",
    NODE_ENV = "development",
} = process.env;

// ====== HTTP client ======
const http = axios.create({
    baseURL: "https://api.mymerchfox.com",
    timeout: 20000,
    validateStatus: () => true, // tự xử lý lỗi
});

// ====== CLI flags ======
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

function parseMerchFoxResp(orderId, res) {
    const { status } = res;
    let raw = res.data;

    // Nếu body là string → thử JSON.parse
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        } catch (_) {
            const head = raw.slice(0, 300).replace(/\s+/g, " ");
            return {
                ok: false,
                err: new Error(`[MerchFox ${status}] Non-JSON for ${orderId}: ${head}`),
            };
        }
    }

    if (!raw || typeof raw !== "object") {
        return {
            ok: false,
            err: new Error(`MerchFox response not JSON (HTTP ${status}) for ${orderId}`),
        };
    }
    if (status >= 400) {
        return {
            ok: false,
            err: new Error(
                `MerchFox HTTP ${status} for ${orderId}: ${raw.message || raw.error || "Error"}`
            ),
        };
    }
    if (raw.code !== 0 || !raw.data) {
        return {
            ok: false,
            err: new Error(
                `MerchFox API code=${raw.code} for ${orderId}: ${raw.message || "Unknown error"}`
            ),
        };
    }
    return { ok: true, data: raw.data };
}

// ✅ Luôn gửi mfid = <Amazon Order ID>
// Ưu tiên GET + body x-www-form-urlencoded (như bạn test Postman), fallback GET query
async function apiGetDetailByAmazonId(orderId) {
    const url = "/storeapi/v2/order/detail";
    const commonHeaders = {
        tokenkey: MERCHFOX_TOKENKEY,
        secret: MERCHFOX_SECRET,
        Accept: "application/json",
    };

    // 1) GET + body x-www-form-urlencoded
    const res1 = await http.request({
        method: "get",
        url,
        headers: {
            ...commonHeaders,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        data: qs.stringify({ mfid: orderId }),
        validateStatus: () => true,
        transformResponse: [(d) => d], // giữ nguyên
    });

    if (DEBUG) {
        const t1 =
            typeof res1.data === "string"
                ? `TEXT(${res1.status})`
                : `JSON(${res1.status}) keys=${Object.keys(res1.data || {})}`;
        console.log(`[MF][TRY GET+BODY] ${t1}`);
    }

    let parsed = parseMerchFoxResp(orderId, res1);
    if (parsed.ok) return parsed.data;

    // 2) Fallback: GET query ?mfid=...
    const res2 = await http.get(url, {
        headers: commonHeaders,
        params: { mfid: orderId },
        validateStatus: () => true,
        transformResponse: [(d) => d],
    });

    if (DEBUG) {
        const t2 =
            typeof res2.data === "string"
                ? `TEXT(${res2.status})`
                : `JSON(${res2.status}) keys=${Object.keys(res2.data || {})}`;
        console.log(`[MF][TRY GET?mfid=] ${t2}`);
    }

    parsed = parseMerchFoxResp(orderId, res2);
    if (parsed.ok) return parsed.data;

    throw parsed.err || new Error(`MerchFox: no valid response for orderId=${orderId}`);
}

async function findOrderLoose(orderId) {
    // exact trước
    const exact = await OrderCustomProduct.findOne({ orderId: orderId.trim() });
    if (exact) return exact;

    // loose (bỏ - và space)
    const loosePattern = new RegExp("^" + norm(orderId).replace(/[-\s]+/g, "[-\\s]?") + "$", "i");
    return OrderCustomProduct.findOne({ orderId: loosePattern });
}

function isShippedByVendor(statusName, trackingNumber) {
    const s = norm(statusName).toLowerCase();
    return s === "completed" || Boolean(norm(trackingNumber));
}

async function applyUpdateToDoc(amazonOrderId, data, keyForAudit) {
    const doc = await findOrderLoose(amazonOrderId);
    if (!doc) throw new Error(`Order not found in DB: ${amazonOrderId}`);

    const trackingNumber = norm(data?.tracking?.number);
    const carrier = norm(data?.tracking?.carrier);
    const statusName = norm(data?.status?.name);
    const shipped = isShippedByVendor(statusName, trackingNumber);

    let changed = 0;
    doc.items = doc.items.map((it) => {
        const ti = it.tracking_info || {};
        const prevTracking = norm(ti.tracking);
        const prevStatus = norm(ti.status);

        const nextTI = {
            ...ti,
            fulfillment: "MerchFox",
            tracking: trackingNumber || prevTracking,
            status: shipped ? "Shipped" : prevStatus || "New",
            updated_at: new Date(),
            note: [norm(ti.note), carrier && `carrier:${carrier}`].filter(Boolean).join(" | "),
        };

        if (
            nextTI.tracking !== prevTracking ||
            nextTI.status !== prevStatus ||
            nextTI.fulfillment !== ti.fulfillment ||
            nextTI.note !== ti.note
        ) {
            changed++;
        }

        return { ...(it.toObject?.() ? it.toObject() : it), tracking_info: nextTI };
    });

    // Nếu mọi item Shipped → set order.status = Shipped
    const allShipped = doc.items.every(
        (it) => norm(it?.tracking_info?.status).toLowerCase() === "shipped"
    );
    let orderStatusChanged = false;
    if (allShipped && doc.status !== "Shipped") {
        doc.status = "Shipped";
        orderStatusChanged = true;
    }

    // Lưu vết MerchFox
    doc.merchfox_submission = {
        ...(doc.merchfox_submission || {}),
        attempt_count: (doc.merchfox_submission?.attempt_count || 0) + 1,
        last_response: data,
        mfid: keyForAudit || doc.merchfox_submission?.mfid || null,
    };

    await doc.save();
    return { updatedItems: changed, tracking: trackingNumber, orderStatusChanged };
}

async function updateOrderFromMerchFox(orderId) {
    const amazonOrderId = orderId.trim();
    const data = await apiGetDetailByAmazonId(amazonOrderId); // mfid = amazonOrderId
    // Dù API trả orderid khác, vẫn áp vào doc theo amazonOrderId (user yêu cầu update đơn này)
    return applyUpdateToDoc(amazonOrderId, data, amazonOrderId);
}

// ====== Batch query (không dùng regex; có fallback purchase_date -> createdAt) ======
function buildBatchQuery({ scope = "vendor", sinceDays, max = 100 }) {
    const base = { status: { $ne: "Shipped" } };
    const q = { ...base };

    if (scope === "vendor") {
        q.$or = [
            { "items.tracking_info.fulfillment": "MerchFox" },
            { "merchfox_submission.mfid": { $exists: true, $ne: null } },
        ];
    } else if (scope === "guess") {
        const days = Number(sinceDays ?? 30);
        const since = new Date(Date.now() - days * 86400 * 1000);
        // fallback: nếu purchase_date trống thì dùng createdAt
        q.$or = [
            { purchase_date: { $gte: since } },
            { purchase_date: null, createdAt: { $gte: since } },
        ];
    } else if (scope === "all") {
        // không lọc thêm
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
            const res = await updateOrderFromMerchFox(o.orderId);
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
                    `Usage: node scripts/merchfox.syncTracking.js one <amazonOrderId> [--debug]`
                );
            const res = await updateOrderFromMerchFox(orderId);
            console.log(JSON.stringify({ ok: true, orderId, ...res }, null, 2));
        } else if (mode === "list") {
            const ids = argv.slice(1).filter((v) => !v.startsWith("--"));
            if (!ids.length)
                throw new Error(
                    `Usage: node scripts/merchfox.syncTracking.js list <id1> <id2> ... [--debug]`
                );
            let ok = 0,
                fail = 0;
            for (const id of ids) {
                try {
                    const r = await updateOrderFromMerchFox(id);
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
  node scripts/merchfox.syncTracking.js one <amazonOrderId> [--debug]
  node scripts/merchfox.syncTracking.js list <id1> <id2> ... [--debug]
  node scripts/merchfox.syncTracking.js batch [--scope vendor|guess|all] [--since-days 30] [--max 200] [--dry-run] [--debug]`
            );
        }
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close().catch(() => { });
    }
})();
