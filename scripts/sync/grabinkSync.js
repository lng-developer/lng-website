/**
 * grabinkSyncAll.js
 * Đồng bộ HÀNG LOẠT đơn với Grabink và cập nhật DB.
 *
 * Chạy ví dụ:
 *   node grabinkSyncAll.js --mongo "mongodb+srv://..." --sinceDays 60 --limit 500 --statuses "New,Sent,Ready,Pending"
 *   # Nếu đã có MONGO_URI trong .env:
 *   node grabinkSyncAll.js --sinceDays 30 --limit 200
 *
 * Tuỳ chọn:
 *   --sinceDays   Số ngày trở lại đây để lọc updatedAt (mặc định 90)
 *   --limit       Giới hạn số đơn (mặc định 500)
 *   --statuses    Danh sách trạng thái cần quét, phân tách bằng dấu phẩy (mặc định: New,Sent,Ready,Pending,Failed)
 *   --concurrency Số tác vụ song song (mặc định 3)
 *   --throttleMs  Nghỉ giữa 2 request (mặc định 250ms)
 *   --dryRun      Chạy thử, KHÔNG ghi DB
 *
 * ENV cần có:
 *   MONGO_URI        (nếu không truyền --mongo)
 *   GRABINK_API_KEY  (API key bạn đang dùng)
 *
 * Logic:
 *   - Tìm các order theo filter
 *   - Gọi: GET https://be.grabink.co/api/external/order/:orderId?api_key=...
 *   - Rút trackingId, ghi vào toàn bộ items[i].tracking_info.tracking
 *   - Set items[i].fulfillment_status = 'Shipped'
 *   - Set order.status = 'Shipped'
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const args = require('minimist')(process.argv.slice(2));

const MONGO_URI = args.mongo || process.env.MONGO_URI;
const SINCE_DAYS = Number(args.sinceDays || 90);
const LIMIT = Number(args.limit || 500);
const DRY_RUN = !!args.dryRun;
const CONCURRENCY = Math.max(1, Number(args.concurrency || 3));
const THROTTLE_MS = Math.max(0, Number(args.throttleMs || 250));

// Mặc định quét các trạng thái này
const EXCLUDE_STATUSES = ['Fulfilled', 'Shipped', 'Cancelled'];
const DEFAULT_STATUSES = []; // mặc định: không chỉ định cụ thể, sẽ dùng $nin EXCLUDE_STATUSES
const STATUSES = String(args.statuses || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const TARGET_STATUSES = STATUSES.length ? STATUSES : DEFAULT_STATUSES;

if (!MONGO_URI) {
    console.error('[Lỗi] Thiếu MONGO_URI (ENV hoặc --mongo).');
    process.exit(1);
}
if (!process.env.GRABINK_API_KEY) {
    console.error('[Lỗi] Thiếu ENV GRABINK_API_KEY.');
    process.exit(1);
}

// ===== Models (lenient) =====
const db = require('../../src/models');
const OrderCustomProduct = db.orderCustomProduct;

// ===== Helpers =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractTrackingId(resp) {
    const r = resp || {};
    if (typeof r === 'string') return r;

    // root
    if (r.trackingId) return String(r.trackingId);
    if (r.tracking_id) return String(r.tracking_id);
    if (r.tracking) return String(r.tracking);
    if (r.trackingNumber) return String(r.trackingNumber);
    if (r.tracking_number) return String(r.tracking_number);

    // data
    const d = r.data || {};
    if (d.trackingId) return String(d.trackingId);
    if (d.tracking_id) return String(d.tracking_id);
    if (d.tracking) return String(d.tracking);

    // shipments
    const shipments = r.shipments || d.shipments || [];
    if (Array.isArray(shipments) && shipments.length > 0) {
        const s0 = shipments[0] || {};
        return String(
            s0.trackingId || s0.tracking_id || s0.tracking || s0.trackingNumber || s0.tracking_number || ''
        );
    }
    return '';
}

async function fetchGrabink(orderId) {
    const url = `https://be.grabink.co/api/external/order/${encodeURIComponent(orderId)}?api_key=${encodeURIComponent(process.env.GRABINK_API_KEY)}`;
    const res = await axios.get(url, { timeout: 20000 });
    return res.data;
}

function ensureObject(o) {
    return (o && typeof o === 'object') ? o : {};
}

// ===== Query orders =====
async function fetchCandidateOrders() {
    const sinceDate = new Date(Date.now() - SINCE_DAYS * 24 * 60 * 60 * 1000);

    const match = {
        items: { $exists: true, $ne: [] },
        // thời gian: updatedAt hoặc createdAt trong khoảng
        $or: [
            { updatedAt: { $gte: sinceDate } },
            { createdAt: { $gte: sinceDate } }
        ]
    };

    if (TARGET_STATUSES.length) {
        // nếu user truyền --statuses, lọc đúng theo đó
        match.status = { $in: TARGET_STATUSES };
    } else {
        // mặc định: quét các đơn chưa kết thúc (với enum của bạn → chính là "New")
        match.status = { $nin: EXCLUDE_STATUSES };
    }

    const orders = await OrderCustomProduct.find(match, {
        orderId: 1,
        status: 1,
        items: 1,
        updatedAt: 1,
        createdAt: 1,
    })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(LIMIT)
        .lean(false);

    return orders;
}

// ===== Worker for one order =====
async function processOneOrder(order) {
    const id = order.orderId || order._id?.toString?.() || '(unknown)';
    try {
        // Gọi Grabink với chính order.orderId
        const resp = await fetchGrabink(order.orderId);
        const trackingId = extractTrackingId(resp);

        if (!trackingId) {
            console.warn(`[Warn] ${id} | Không lấy được trackingId. Bỏ qua.`);
            return { saved: false, reason: 'no-tracking' };
        }

        // Cập nhật toàn bộ items
        const items = Array.isArray(order.items) ? order.items : [];
        items.forEach(it => {
            it.tracking_info = ensureObject(it.tracking_info);
            it.tracking_info.tracking = trackingId;
            it.tracking_info.source = 'grabink';
            it.tracking_info.updated_at = new Date();
            it.fulfillment_status = 'Shipped';
        });

        // Cập nhật order-level
        order.status = 'Shipped';
        order.shipped_at = new Date(); // (tùy chọn lưu)

        if (DRY_RUN) {
            console.log(`[DryRun] ${id} | would set Shipped, items=${items.length}, trackingId=${trackingId}`);
            return { saved: false, dryRun: true };
        } else {
            await order.save();
            console.log(`[Saved] ${id} | Shipped | items=${items.length} | trackingId=${trackingId}`);
            return { saved: true };
        }
    } catch (err) {
        const msg = err?.response?.data ? JSON.stringify(err.response.data) : (err.message || String(err));
        console.error(`[Error] ${id} | ${msg}`);
        return { saved: false, error: msg };
    }
}

// ===== Simple concurrency queue =====
async function runQueue(items, worker, { concurrency, throttleMs }) {
    let inFlight = 0;
    let idx = 0;
    let done = 0;

    return new Promise((resolve) => {
        const results = [];
        const next = async () => {
            if (idx >= items.length && inFlight === 0) {
                return resolve(results);
            }
            while (inFlight < concurrency && idx < items.length) {
                const curIndex = idx++;
                const item = items[curIndex];
                inFlight++;

                (async () => {
                    const r = await worker(item);
                    results[curIndex] = r;
                    done++;
                    inFlight--;
                    if (throttleMs) await sleep(throttleMs);
                    next();
                })();
            }
        };
        next();
    });
}

// ===== Main =====
(async () => {
    await mongoose.connect(MONGO_URI, { autoIndex: false });
    console.log(`[Info] Connected Mongo. sinceDays=${SINCE_DAYS}, limit=${LIMIT}, statuses=${TARGET_STATUSES.join('|')}, dryRun=${DRY_RUN}`);

    const orders = await fetchCandidateOrders();
    if (!orders.length) {
        console.log('[Info] Không có order nào phù hợp filter.');
        await mongoose.disconnect();
        return;
    }

    console.log(`[Info] Bắt đầu xử lý ${orders.length} đơn | concurrency=${CONCURRENCY}, throttleMs=${THROTTLE_MS}`);

    const results = await runQueue(
        orders,
        processOneOrder,
        { concurrency: CONCURRENCY, throttleMs: THROTTLE_MS }
    );

    const summary = results.reduce((acc, r) => {
        acc.total++;
        if (r?.saved) acc.saved++;
        else if (r?.dryRun) acc.dryRun++;
        else if (r?.reason === 'no-tracking') acc.noTracking++;
        else acc.failed++;
        return acc;
    }, { total: 0, saved: 0, dryRun: 0, noTracking: 0, failed: 0 });

    console.log('\n===== SUMMARY =====');
    console.log(summary);

    await mongoose.disconnect();
    console.log('[Done] Disconnected Mongo.');
})().catch(async (err) => {
    console.error('[Fatal]', err);
    try { await mongoose.disconnect(); } catch (e) { }
    process.exit(1);
});
