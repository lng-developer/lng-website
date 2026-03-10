#!/usr/bin/env node
/**
 * Assign sellers to orders by parsing MSNV from item.sku (format: msnv-configcode-date)
 * - Majority vote per order across its items' MSNVs
 * - Map MSNV -> User._id via User.employee_id
 *
 * CLI flags:
 *   --mongo        MongoDB URI (default: process.env.MONGODB_URI)
 *   --sinceDays    Only scan orders created within last N days (default: 36500 = ~100 years)
 *   --limit        Max number of orders to process (default: 0 = no limit)
 *   --shopId       Only process orders of specific Shop _id (optional)
 *   --override     If present and true, override existing sellerId (default: false)
 *   --dryRun       If present and true, no DB writes (default: false)
 *   --concurrency  Number of concurrent updates (default: 10)
 *   --status       Comma list of statuses to include (default: all) e.g., "New,Fulfilled,Shipped"
 *
 * Usage examples:
 *   node scripts/assignSellersFromSku.js --sinceDays=90 --dryRun
 *   node scripts/assignSellersFromSku.js --override --limit=1000
 *   node scripts/assignSellersFromSku.js --shopId=66f0b8... --status=New,Shipped --concurrency=20
 */

const mongoose = require('mongoose');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// ====== Load your models index ======
const db = require('../../src/models'); // đảm bảo ../models/index.js export { orderCustomProduct, user, ... }
const OrderCustomProduct = db.orderCustomProduct;
const User = db.user;

// ---------- Helpers ----------
function extractMSNVFromSKU(sku) {
    if (!sku || typeof sku !== 'string') return null;
    const first = sku.split('-')[0]?.trim();
    return first ? first.toUpperCase() : null;
}

function pickMajorityMSNVFromSkus(skus = []) {
    const counts = new Map();
    for (const s of skus) {
        const msnv = extractMSNVFromSKU(s);
        if (!msnv) continue;
        counts.set(msnv, (counts.get(msnv) || 0) + 1);
    }
    if (!counts.size) return null;
    let best = null, bestCnt = -1;
    for (const [k, v] of counts.entries()) {
        if (v > bestCnt) { best = k; bestCnt = v; }
    }
    return best;
}

async function findSellerIdByEmployeeId(msnv) {
    if (!msnv) return null;
    const user = await User.findOne({ employee_id: msnv }).select('_id').lean();
    return user?._id || null;
}

// Simple async pool
async function asyncPool(limit, array, iteratorFn) {
    const ret = [];
    const executing = [];
    for (const item of array) {
        const p = Promise.resolve().then(() => iteratorFn(item));
        ret.push(p);
        if (limit <= array.length) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1));
            executing.push(e);
            if (executing.length >= limit) {
                await Promise.race(executing);
            }
        }
    }
    return Promise.all(ret);
}

// ---------- Main ----------
(async () => {
    const argv = yargs(hideBin(process.argv))
        .option('mongo', { type: 'string', default: process.env.MONGO_URI })
        .option('sinceDays', { type: 'number', default: 36500 })
        .option('limit', { type: 'number', default: 0 })
        .option('shopId', { type: 'string' })
        .option('override', { type: 'boolean', default: false })
        .option('dryRun', { type: 'boolean', default: false })
        .option('concurrency', { type: 'number', default: 10 })
        .option('status', { type: 'string' })
        .demandOption(['mongo'], 'Missing MongoDB URI. Set --mongo or MONGODB_URI env.')
        .help()
        .argv;

    const {
        mongo, sinceDays, limit, shopId, override, dryRun, concurrency, status
    } = argv;

    // Connect
    await mongoose.connect(mongo, { maxPoolSize: 10 });
    console.log('[Info] Connected Mongo.');

    // Build filter
    const filter = {};
    if (Number.isFinite(sinceDays) && sinceDays >= 0) {
        const since = new Date();
        since.setDate(since.getDate() - sinceDays);
        filter.createdAt = { $gte: since };
    }
    if (shopId) {
        filter.shopId = shopId;
    }
    if (status) {
        const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
        if (statuses.length) {
            filter.status = { $in: statuses };
        }
    }

    console.log('[Info] Filter:', JSON.stringify(filter));

    // Use a cursor to avoid loading everything at once
    const cursor = OrderCustomProduct.find(filter).select('orderId items sellerId').cursor();

    let scanned = 0;
    let updated = 0;
    let keptExisting = 0;
    let noMsNv = 0;
    let noUser = 0;
    let failed = 0;
    const work = [];

    async function handleOrder(orderDoc) {
        try {
            scanned++;
            const { orderId, items } = orderDoc;

            const skus = Array.isArray(items) ? items.map(i => i?.sku).filter(Boolean) : [];
            const msnv = pickMajorityMSNVFromSkus(skus);

            if (!msnv) {
                noMsNv++;
                console.log(`[No-MSNV] orderId=${orderId} -> cannot parse MSNV from items' SKU`);
                return;
            }

            const sellerId = await findSellerIdByEmployeeId(msnv);
            if (!sellerId) {
                noUser++;
                console.log(`[No-User] orderId=${orderId} msnv=${msnv} -> no User.employee_id match`);
                return;
            }

            if (orderDoc.sellerId && !override) {
                keptExisting++;
                // Keep current seller
                // console.log(`[Keep] orderId=${orderId} has sellerId=${orderDoc.sellerId}, msnv=${msnv}`);
                return;
            }

            if (dryRun) {
                updated++;
                console.log(`[DryRun-Assign] orderId=${orderId} sellerId=${sellerId} (msnv=${msnv})`);
                return;
            }

            // Save
            orderDoc.sellerId = sellerId;
            await orderDoc.save();
            updated++;
            console.log(`[Assigned] orderId=${orderId} sellerId=${sellerId} (msnv=${msnv})`);
        } catch (err) {
            failed++;
            console.error(`[Error] orderId=${orderDoc?.orderId} ${err?.message || err}`);
        }
    }

    for await (const doc of cursor) {
        work.push(doc);
        // Process in chunks using async pool
        if (work.length >= concurrency * 5) {
            await asyncPool(concurrency, work.splice(0), handleOrder);
            if (limit && scanned >= limit) break;
        }
        if (limit && scanned >= limit) break;
    }
    // Flush remaining
    if (work.length) {
        await asyncPool(concurrency, work.splice(0), handleOrder);
    }

    console.log('--------------------------------------------------');
    console.log('[Summary]');
    console.log(' Scanned         :', scanned);
    console.log(' Assigned/Updated:', updated, dryRun ? '(dry-run)' : '');
    console.log(' Kept existing   :', keptExisting);
    console.log(' No MSNV parsed  :', noMsNv);
    console.log(' No user match   :', noUser);
    console.log(' Failed          :', failed);

    await mongoose.disconnect();
    process.exit(0);
})().catch(async (e) => {
    console.error('[Fatal]', e);
    try { await mongoose.disconnect(); } catch { }
    process.exit(1);
});
