// scripts/beeful.syncTracking.js
// Usage:
//   node scripts/beeful.syncTracking.js one 111-3527486-3331422
//   node scripts/beeful.syncTracking.js batch
//
// Env cần dùng:
//   MONGO_URI=... (URI MongoDB của bạn)
//   GRABINK_API_KEY=... (API key Beeful - tái sử dụng biến cũ)

const mongoose = require("mongoose");
const axios = require("axios").default;
const db = require('../../src/models');
const OrderCustomProduct = db.orderCustomProduct;
// ==== ENV ====
const {
    MONGO_URI = "mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net/lng_db?retryWrites=true&w=majority&appName=LNGWeb",
    GRABINK_API_KEY = "e9de91b4-4912-4ab1-8c4d-260f046b5ebf",
    NODE_ENV = "development",
} = process.env;

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const DEBUG = hasFlag("--debug");
const SHOW_RAW = hasFlag("--raw");

// Dùng endpoint cố định theo bạn cung cấp
const BEEFUL_API_BASE = "https://be.grabink.co";

const http = axios.create({
    baseURL: BEEFUL_API_BASE,
    timeout: 15000,
});

const isShippedFlag = (statusFromVendor) =>
    norm(statusFromVendor).toLowerCase() === "shipped";

// ==== Helpers ====
function norm(s) {
    return String(s || "").trim();
}

// Unwrap nhiều kiểu response: {data:{...}}, {result:{...}}, {order:{...}}, {payload:{...}} hoặc trả thẳng object
function unwrapBeeful(raw) {
    if (!raw || typeof raw !== "object") return {};
    if (raw.data && typeof raw.data === "object") return raw.data;
    if (raw.result && typeof raw.result === "object") return raw.result;
    if (raw.order && typeof raw.order === "object") return raw.order;
    if (raw.payload && typeof raw.payload === "object") return raw.payload;
    return raw;
}

function extractTracking(unwrapped) {
    const t1 = unwrapped?.tracking?.trackingNumber;
    const t2 = unwrapped?.trackingId;
    const t3 = unwrapped?.trackingNumber;
    return norm(t1 || t2 || t3 || "");
}

function extractStatus(unwrapped) {
    return norm(unwrapped?.status || "");
}

async function fetchBeefulOrder(orderId) {
    const url = `/api/external/order/${encodeURIComponent(orderId)}`;

    const doOnce = async () => {
        const res = await http.get(url, {
            params: { api_key: GRABINK_API_KEY },
            // giữ nguyên để tự xử lý thông điệp lỗi
            validateStatus: () => true,
        });

        const { status, data: raw } = res;

        if (SHOW_RAW || DEBUG) {
            console.log("[BEEFUL][HTTP]", status, "->", typeof raw, Array.isArray(raw) ? "array" : "object");
            if (DEBUG) {
                try { console.log("[BEEFUL][RAW]", JSON.stringify(raw, null, 2)); }
                catch { console.log("[BEEFUL][RAW]", raw); }
            }
        }

        // Xử lý lỗi phổ biến: API trả { statusCode, message }
        // Hoặc các dạng có field error/message mô tả
        if (status >= 400) {
            const msg =
                (raw && (raw.message || raw.error || raw.detail)) ||
                `HTTP ${status}`;
            throw new Error(`Beeful error for ${orderId}: ${msg}`);
        }

        if (!raw || typeof raw !== "object") {
            throw new Error(`Beeful response empty for ${orderId}`);
        }

        const data = unwrapBeeful(raw);

        // Tối thiểu nên có 1 trường nhận diện đơn
        if (!data || typeof data !== "object" || (!data.code && !data.strOrderId)) {
            const keys = Object.keys(raw || {});
            throw new Error(
                `Unexpected Beeful shape for ${orderId}. Top-level keys: ${keys.join(", ")}`
            );
        }

        return data;
    };

    // Retry nhẹ nhàng khi 429/5xx
    const maxRetry = 2;
    for (let i = 0; i <= maxRetry; i++) {
        try {
            return await doOnce();
        } catch (err) {
            const msg = String(err.message || "");
            const retriable =
                /HTTP 5\d\d/.test(msg) ||
                /429/.test(msg) ||
                /timeout/i.test(msg);
            if (retriable && i < maxRetry) {
                const backoffMs = 500 * (i + 1);
                if (DEBUG) console.log(`[BEEFUL][RETRY] attempt ${i + 2}/${maxRetry + 1} in ${backoffMs}ms :: ${msg}`);
                await new Promise((r) => setTimeout(r, backoffMs));
                continue;
            }
            throw err;
        }
    }
}


// Tìm order theo exact trước, nếu không có thử “lỏng” (bỏ - và khoảng trắng)
async function findOrderLoose(orderId) {
    const exact = await OrderCustomProduct.findOne({ orderId: orderId.trim() });
    if (exact) return exact;

    // Regex “lỏng”: cho phép thiếu/thừa dấu '-' hoặc khoảng trắng
    // Ví dụ "113-6829797-5167438" -> /1\s*-?\s*1\s*3\s*-?\s*6.../ (nhẹ nhàng hơn: thay -/space bằng nhóm [-\s]? một lần)
    const loosePattern = new RegExp(
        "^" + norm(orderId).replace(/[-\s]+/g, "[-\\s]?") + "$",
        "i"
    );
    return OrderCustomProduct.findOne({ orderId: loosePattern });
}

async function updateOrderFromBeeful(orderId) {
    const data = await fetchBeefulOrder(orderId); // đã unwrap
    const tracking = extractTracking(data);
    const status = extractStatus(data);
    const shippedFromVendor =
        isShippedFlag(status) || Boolean(tracking && tracking.length > 0);

    // Tìm đơn trong DB (dùng loose để an toàn)
    const doc = await findOrderLoose(orderId);
    if (!doc) throw new Error(`Order not found in DB: ${orderId}`);

    let changed = 0;

    // Cập nhật tất cả items
    doc.items = doc.items.map((it) => {
        const ti = it.tracking_info || {};
        const prevTracking = norm(ti.tracking);
        const prevStatus = norm(ti.status);

        const nextTI = {
            ...ti,
            fulfillment: "Beeful",
            tracking: tracking || prevTracking, // có mới thì cập nhật, không thì giữ
            status: shippedFromVendor ? "Shipped" : prevStatus || "New",
            updated_at: new Date(),
        };

        if (
            nextTI.tracking !== prevTracking ||
            nextTI.status !== prevStatus ||
            nextTI.fulfillment !== ti.fulfillment
        ) {
            changed++;
        }

        // đảm bảo trả về plain object khi item là subdoc
        return { ...(it.toObject?.() ? it.toObject() : it), tracking_info: nextTI };
    });

    // Nếu tất cả items Shipped -> set order.status = Shipped
    const allShipped = doc.items.every(
        (it) => norm(it?.tracking_info?.status).toLowerCase() === "shipped"
    );
    let orderStatusChanged = false;
    if (allShipped && doc.status !== "Shipped") {
        doc.status = "Shipped";
        orderStatusChanged = true;
    }

    // Lưu vết dưới dạng beeful_submission (không sửa schema — lưu mềm)
    try {
        doc.beeful_submission = {
            ...(doc.beeful_submission || {}),
            attempt_count: (doc.beeful_submission?.attempt_count || 0) + 1,
            last_response: data, // lưu object đã unwrap cho gọn
        };
    } catch (_) { }

    await doc.save();
    return { updatedItems: changed, tracking, orderStatusChanged };
}

const getFlagVal = (name, def = undefined) => {
    const idx = argv.indexOf(name);
    if (idx === -1) return def;
    const v = argv[idx + 1];
    if (!v || v.startsWith("--")) return def;
    return v;
};

// ==== Batch finder helper ====
function buildBatchQuery({ scope = "vendor", sinceDays, max = 100 }) {
    const base = { status: { $ne: "Shipped" } };
    const now = new Date();

    const q = { ...base };
    if (scope === "vendor") {
        // như cũ (chỉ các đơn đã có dấu hiệu Beeful)
        q.$or = [
            { "items.tracking_info.fulfillment": "Beeful" },
            { "beeful_submission.sent": true },
        ];
    } else if (scope === "guess") {
        // đoán rộng: đơn chưa Shipped trong N ngày gần đây (mặc định 30)
        const days = Number(sinceDays ?? 30);
        const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        q.purchase_date = { $gte: since };
        // chỉ quét orderId có dạng Amazon để tránh rác
        q.orderId = { $regex: /^\d{3}-\d{7}-\d{7}$/ };
    } else if (scope === "all") {
        // tất cả đơn chưa Shipped (nguy hiểm nếu dữ liệu lớn) – khuyến nghị đi kèm --max nhỏ
        q.orderId = { $regex: /^\d{3}-\d{7}-\d{7}$/ };
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
        return { ok: true, scanned: candidates.length };
    }

    let ok = 0,
        fail = 0;
    for (const o of candidates) {
        try {
            const res = await updateOrderFromBeeful(o.orderId);
            if (DEBUG || process.env.NODE_ENV !== "test") {
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

// ==== CLI Entrypoint (chỉ cập nhật phần lấy mode & truyền flags) ====
(async () => {
    try {
        await mongoose.connect(MONGO_URI, {});
        const { host, port, name } = mongoose.connection;
        console.log(`[DB] connected: ${host}:${port}/${name}`);

        const mode = argv[0];
        if (mode === "one") {
            const orderId = argv[1];
            if (!orderId)
                throw new Error(
                    `Usage: node scripts/beeful.syncTracking.js one <orderId> [--debug] [--raw]`
                );
            const res = await updateOrderFromBeeful(orderId);
            console.log(JSON.stringify({ ok: true, orderId, ...res }, null, 2));
        } else if (mode === "batch") {
            const r = await runBatch();
            console.log(JSON.stringify(r, null, 2));
        } else if (mode === "list") {
            const ids = argv.slice(1).filter((v) => !v.startsWith("--"));
            if (!ids.length)
                throw new Error(
                    `Usage: node scripts/beeful.syncTracking.js list <id1> <id2> ... [--debug]`
                );
            let ok = 0,
                fail = 0;
            for (const oid of ids) {
                try {
                    const res = await updateOrderFromBeeful(oid);
                    console.log(
                        `[OK] ${oid} => tracking=${res.tracking}, orderStatusChanged=${res.orderStatusChanged}`
                    );
                    ok++;
                } catch (err) {
                    console.error(`[FAIL] ${oid}:`, err.message);
                    fail++;
                }
            }
            console.log(JSON.stringify({ ok, fail, scanned: ids.length }, null, 2));
        } else {
            console.log(
                `Usage:
  node scripts/beeful.syncTracking.js one <orderId> [--debug] [--raw]
  node scripts/beeful.syncTracking.js batch [--scope vendor|guess|all] [--since-days 30] [--max 200] [--dry-run] [--debug]
  node scripts/beeful.syncTracking.js list <id1> <id2> ... [--debug]`
            );
        }
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        await mongoose.connection.close().catch(() => { });
    }
})();
