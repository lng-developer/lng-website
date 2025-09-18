// scripts/vendor.syncTracking.js
// Usage:
//   node scripts/vendor.syncTracking.js one <amazonOrderId> [--debug]
//   node scripts/vendor.syncTracking.js list <id1> <id2> ... [--debug]
//   node scripts/vendor.syncTracking.js batch [--max 200] [--dry-run] [--debug]
//
// ENV (.env):
//   MONGO_URI=...
//   GRABINK_API_KEY=...         # Beeful (grabink)
//   MERCHFOX_TOKENKEY=...
//   MERCHFOX_SECRET=...
//   MERCHIZE_ACCESS_TOKEN=...

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const axios = require("axios").default;
const qs = require("querystring");

// ====== Models ======
const db = require("../src/models");
const OrderCustomProduct = db.orderCustomProduct;
const VendorProduct = db.vendorProduct || mongoose.model("VendorProduct");
const Vendor = db.vendor || mongoose.model("Vendor");

// ====== ENV ======
const {
    MONGO_URI = "mongodb://127.0.0.1:27017/lng",
    NODE_ENV = "development",

    // Beeful
    GRABINK_API_KEY = "",

    // MerchFox
    MERCHFOX_TOKENKEY = "",
    MERCHFOX_SECRET = "",

    // Merchize
    MERCHIZE_ACCESS_TOKEN = "",
} = process.env;

// ====== HTTP clients ======
const httpBeeful = axios.create({
    baseURL: "https://be.grabink.co",
    timeout: 20000,
    validateStatus: () => true,
});
const httpMerchFox = axios.create({
    baseURL: "https://api.mymerchfox.com",
    timeout: 20000,
    validateStatus: () => true,
});
const httpMerchize = axios.create({
    baseURL: "https://bo-group-1-2.merchize.com/403c7ev/bo-api",
    timeout: 20000,
    headers: {
        Authorization: `Bearer ${MERCHIZE_ACCESS_TOKEN}`,
        Accept: "application/json",
    },
    validateStatus: () => true,
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
const lower = (s) => norm(s).toLowerCase();

function normalizeVendorKey(nameOrType) {
    const s = lower(nameOrType);
    if (!s) return "";
    if (s.includes("beeful") || s.includes("grabink")) return "beeful";
    if (s.includes("merchfox") || s.includes("merch fox")) return "merchfox";
    if (s.includes("merchize")) return "merchize";
    if (["beeful", "merchfox", "merchize"].includes(s)) return s;
    return "";
}

/**
 * Prefetch toàn bộ mapping:
 *   vendorProductId -> { vendorKey, vendorName }
 */
async function buildVendorMapsFromVpidSet(vpidSet) {
    const vpids = Array.from(vpidSet);
    if (vpids.length === 0) return new Map();

    const vps = await VendorProduct.find({ _id: { $in: vpids } })
        .select({ _id: 1, vendor_id: 1 })
        .lean();

    const vendorIds = [...new Set(vps.map((vp) => vp.vendor_id).filter(Boolean))];
    const vendors = vendorIds.length
        ? await Vendor.find({ _id: { $in: vendorIds } })
            .select({ _id: 1, name: 1, fulfillment_type: 1 })
            .lean()
        : [];

    const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));
    const vpidToVendor = new Map();

    for (const vp of vps) {
        const vend = vendorMap.get(String(vp.vendor_id));
        const vendorKey =
            normalizeVendorKey(vend?.fulfillment_type) || normalizeVendorKey(vend?.name);
        vpidToVendor.set(String(vp._id), {
            vendorKey,
            vendorName: vend?.name || "",
        });
    }
    return vpidToVendor;
}

/**
 * Group item index theo vendorKey, dùng map đã prefetch.
 * Trả về { vendorKey: { itemIndexes: number[] } }
 */
function groupItemsByVendorWithMap(doc, vpidToVendor) {
    const groups = {};
    for (let i = 0; i < (doc.items || []).length; i++) {
        const it = doc.items[i];
        const vpid = it?.cost_breakdown?.vendorProductId;
        const info = vpid ? vpidToVendor.get(String(vpid)) : null;
        const key = info?.vendorKey || "unknown";
        if (!groups[key]) groups[key] = { itemIndexes: [] };
        groups[key].itemIndexes.push(i);
    }
    return groups;
}

// ====== Vendor fetchers: trả về {tracking, carrier, shipped, raw}
async function fetchBeeful(orderId) {
    const url = `/api/external/order/${encodeURIComponent(orderId)}`;
    const res = await httpBeeful.get(url, { params: { api_key: GRABINK_API_KEY } });
    if (DEBUG) console.log("[Beeful][HTTP]", res.status, "| keys:", Object.keys(res.data || {}));
    if (!res.data || typeof res.data !== "object") throw new Error(`Beeful empty (HTTP ${res.status})`);
    if (res.status >= 400 || res.data?.message === "Not Found" || res.data?.error) {
        throw new Error(`Beeful error: ${res.data?.message || res.data?.error || res.status}`);
    }
    const raw = res.data;
    const tracking = norm(raw?.tracking?.trackingNumber) || norm(raw?.trackingId) || "";
    const carrier = norm(raw?.shippingProvider);
    const shipped = lower(raw?.status) === "shipped" || Boolean(tracking);
    return { tracking, carrier, shipped, raw };
}

function parseMerchFoxResp(orderId, res) {
    const { status } = res;
    let raw = res.data;
    if (typeof raw === "string") {
        try {
            raw = JSON.parse(raw);
        } catch (e) {
            const head = raw.slice(0, 300).replace(/\s+/g, " ");
            throw new Error(`[MerchFox ${status}] Non-JSON for ${orderId}: ${head}`);
        }
    }
    if (!raw || typeof raw !== "object") throw new Error(`MerchFox bad JSON (HTTP ${status})`);
    if (status >= 400) throw new Error(`MerchFox HTTP ${status}: ${raw.message || raw.error || "Error"}`);
    if (raw.code !== 0 || !raw.data) throw new Error(`MerchFox API code=${raw.code}: ${raw.message || "Unknown"}`);
    return raw.data;
}

// MerchFox: mfid = Amazon orderId (GET + body form ưu tiên; fallback GET query)
async function fetchMerchFox(orderId) {
    const url = "/storeapi/v2/order/detail";
    // GET + body form
    const res1 = await httpMerchFox.request({
        method: "get",
        url,
        headers: {
            tokenkey: MERCHFOX_TOKENKEY,
            secret: MERCHFOX_SECRET,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        data: qs.stringify({ mfid: orderId }),
        transformResponse: [(d) => d],
    });
    if (DEBUG) console.log("[MerchFox][TRY GET+BODY]", res1.status);
    try {
        const data = parseMerchFoxResp(orderId, res1);
        const tracking = norm(data?.tracking?.number);
        const carrier = norm(data?.tracking?.carrier);
        const shipped = lower(data?.status?.name) === "completed" || Boolean(tracking);
        return { tracking, carrier, shipped, raw: data };
    } catch (_) {
        // fallback GET query
        const res2 = await httpMerchFox.get(url, {
            headers: {
                tokenkey: MERCHFOX_TOKENKEY,
                secret: MERCHFOX_SECRET,
                Accept: "application/json",
            },
            params: { mfid: orderId },
            transformResponse: [(d) => d],
        });
        if (DEBUG) console.log("[MerchFox][TRY GET?mfid=]", res2.status);
        const data = parseMerchFoxResp(orderId, res2);
        const tracking = norm(data?.tracking?.number);
        const carrier = norm(data?.tracking?.carrier);
        const shipped = lower(data?.status?.name) === "completed" || Boolean(tracking);
        return { tracking, carrier, shipped, raw: data };
    }
}

// Merchize: ưu tiên tracking, fallback order-detail
async function fetchMerchize(orderId) {
    // tracking
    let res = await httpMerchize.get("/order/external/orders/tracking", {
        params: { external_number: orderId },
    });
    if (DEBUG) console.log("[Merchize][HTTP tracking]", res.status, "| keys:", Object.keys(res.data || {}));
    if (res.status >= 400) throw new Error(`Merchize HTTP ${res.status} (tracking)`);
    if (res.data?.success === true && Array.isArray(res.data.data) && res.data.data.length > 0) {
        const obj = res.data.data[0];
        const tracking = norm(obj?.tracking_number);
        const carrier = norm(obj?.tracking_company);
        const shipped = lower(obj?.status) === "fulfilled" || Boolean(tracking);
        return { tracking, carrier, shipped, raw: obj };
    }
    // order-detail
    res = await httpMerchize.get("/order/external/orders/order-detail", {
        params: { external_number: orderId },
    });
    if (DEBUG) console.log("[Merchize][HTTP detail]", res.status, "| keys:", Object.keys(res.data || {}));
    if (res.status >= 400) throw new Error(`Merchize HTTP ${res.status} (detail)`);
    if (res.data?.success === true && Array.isArray(res.data.data) && res.data.data.length > 0) {
        const obj = res.data.data[0];
        const tracking = norm(obj?.tracking_number);
        const carrier = norm(obj?.tracking_company);
        const shipped = lower(obj?.status) === "fulfilled" || Boolean(tracking);
        return { tracking, carrier, shipped, raw: obj };
    }
    throw new Error(`Merchize empty for ${orderId}`);
}

// ====== Áp kết quả vào doc cho nhóm item thuộc vendorKey ======
function applyToItemsOfVendor(doc, vendorKey, { tracking, carrier, shipped, raw }) {
    let changed = 0;

    doc.items = doc.items.map((it) => {
        const vpid = it?.cost_breakdown?.vendorProductId;
        const cached = vpid ? doc.__vpidToVendor?.get(String(vpid)) : null;
        const thisVendorKey = cached?.vendorKey || "";

        if (thisVendorKey !== vendorKey) {
            return it.toObject?.() ? it.toObject() : it;
        }

        const ti = it.tracking_info || {};
        const prevTracking = norm(ti.tracking);
        const prevStatus = norm(ti.status);

        const nextTI = {
            ...ti,
            fulfillment:
                vendorKey === "beeful"
                    ? "Beeful"
                    : vendorKey === "merchfox"
                        ? "MerchFox"
                        : vendorKey === "merchize"
                            ? "Merchize"
                            : norm(ti.fulfillment),
            tracking: tracking || prevTracking,
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

    // lưu vết theo vendor
    if (vendorKey === "beeful") {
        doc.beeful_submission = {
            ...(doc.beeful_submission || {}),
            attempt_count: (doc.beeful_submission?.attempt_count || 0) + 1,
            last_response: raw,
        };
    } else if (vendorKey === "merchfox") {
        doc.merchfox_submission = {
            ...(doc.merchfox_submission || {}),
            attempt_count: (doc.merchfox_submission?.attempt_count || 0) + 1,
            last_response: raw,
            mfid: doc.orderId,
        };
    } else if (vendorKey === "merchize") {
        doc.merchize_submission = {
            ...(doc.merchize_submission || {}),
            attempt_count: (doc.merchize_submission?.attempt_count || 0) + 1,
            last_response: raw,
        };
    }

    return changed;
}

async function updateOrderByVendors(orderId, vpidToVendorPrefetched = null) {
    const doc = await OrderCustomProduct.findOne({ orderId: orderId.trim() });
    if (!doc) throw new Error(`Order not found in DB: ${orderId}`);

    // chuẩn bị map vendor cho doc
    let vpidSet = new Set();
    for (const it of doc.items || []) {
        const vpid = it?.cost_breakdown?.vendorProductId;
        if (vpid) vpidSet.add(String(vpid));
    }
    const vpidToVendor =
        vpidToVendorPrefetched || (await buildVendorMapsFromVpidSet(vpidSet));

    // attach map vào doc để applyToItemsOfVendor dùng nhanh
    doc.__vpidToVendor = vpidToVendor;

    // nhóm item theo vendor
    const groups = groupItemsByVendorWithMap(doc, vpidToVendor);
    const vendorKeys = Object.keys(groups).filter((k) =>
        ["beeful", "merchfox", "merchize"].includes(k)
    );

    if (vendorKeys.length === 0) {
        throw new Error(
            `No known vendor mapping from items.cost_breakdown.vendorProductId for ${orderId}`
        );
    }

    let totalChanged = 0;
    for (const vk of vendorKeys) {
        try {
            let res;
            if (vk === "beeful") res = await fetchBeeful(orderId);
            else if (vk === "merchfox") res = await fetchMerchFox(orderId);
            else if (vk === "merchize") res = await fetchMerchize(orderId);
            else continue;

            totalChanged += applyToItemsOfVendor(doc, vk, res);
        } catch (e) {
            console.error(`[VENDOR FAIL][${vk}] ${orderId}:`, e.message);
        }
    }

    // cập nhật status tổng nếu tất cả items đã Shipped
    const allShipped = (doc.items || []).every(
        (it) => lower(it?.tracking_info?.status) === "shipped"
    );
    let orderStatusChanged = false;
    if (allShipped && doc.status !== "Shipped") {
        doc.status = "Shipped";
        orderStatusChanged = true;
    }

    await doc.save();
    return { updatedItems: totalChanged, orderStatusChanged };
}

// ====== Batch (STRICT theo vendorProductId, không đoán) ======
async function runBatch() {
    const max = Number(getFlagVal("--max", "100"));
    const dryRun = hasFlag("--dry-run");

    // B1) Lấy order ứng viên: chưa Shipped & có ít nhất 1 vendorProductId
    const candidates = await OrderCustomProduct.find({
        status: { $ne: "Shipped" },
        "items.cost_breakdown.vendorProductId": { $exists: true, $ne: null },
    })
        .sort({ createdAt: -1 })
        .limit(max)
        .lean();

    // B2) Thu thập toàn bộ vendorProductId để prefetch
    const vpidSet = new Set();
    for (const o of candidates) {
        for (const it of o.items || []) {
            const vpid = it?.cost_breakdown?.vendorProductId;
            if (vpid) vpidSet.add(String(vpid));
        }
    }
    const vpidToVendor = await buildVendorMapsFromVpidSet(vpidSet);

    // B3) Lọc các order thực sự có vendorKey hợp lệ
    const knownKeys = new Set(["beeful", "merchfox", "merchize"]);
    const filtered = candidates.filter((o) => {
        const groups = groupItemsByVendorWithMap(o, vpidToVendor);
        return Object.keys(groups).some((k) => knownKeys.has(k));
    });

    if (dryRun) {
        console.log(
            JSON.stringify(
                {
                    ok: true,
                    mode: "dry-run",
                    scanned: filtered.length,
                    orderIds: filtered.map((o) => o.orderId),
                    vendorsPerOrder: filtered.map((o) => {
                        const g = groupItemsByVendorWithMap(o, vpidToVendor);
                        return {
                            orderId: o.orderId,
                            vendorKeys: Object.keys(g).filter((k) => knownKeys.has(k)),
                        };
                    }),
                },
                null,
                2
            )
        );
        return { ok: true, fail: 0, scanned: filtered.length };
    }

    // B4) Thực thi
    let ok = 0,
        fail = 0;
    for (const o of filtered) {
        try {
            const r = await updateOrderByVendors(o.orderId, vpidToVendor);
            if (DEBUG || NODE_ENV !== "test") {
                console.log(
                    `[OK] ${o.orderId} | itemsChanged=${r.updatedItems} | orderStatusChanged=${r.orderStatusChanged}`
                );
            }
            ok++;
        } catch (err) {
            console.error(`[FAIL] ${o.orderId}:`, err.message);
            fail++;
        }
    }
    return { ok, fail, scanned: filtered.length };
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
                    `Usage: node scripts/vendor.syncTracking.js one <amazonOrderId> [--debug]`
                );
            const res = await updateOrderByVendors(orderId);
            console.log(JSON.stringify({ ok: true, orderId, ...res }, null, 2));
        } else if (mode === "list") {
            const ids = argv.slice(1).filter((v) => !v.startsWith("--"));
            if (!ids.length)
                throw new Error(
                    `Usage: node scripts/vendor.syncTracking.js list <id1> <id2> ... [--debug]`
                );
            let ok = 0,
                fail = 0;
            for (const id of ids) {
                try {
                    const r = await updateOrderByVendors(id);
                    console.log(
                        `[OK] ${id} => itemsChanged=${r.updatedItems}, orderStatusChanged=${r.orderStatusChanged}`
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
  node scripts/vendor.syncTracking.js one <amazonOrderId> [--debug]
  node scripts/vendor.syncTracking.js list <id1> <id2> ... [--debug]
  node scripts/vendor.syncTracking.js batch [--max 200] [--dry-run] [--debug]`
            );
        }
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close().catch(() => { });
    }
})();
