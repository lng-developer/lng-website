const db = require("../models");
const SkuMappingConfig = db.SkuMappingConfig;
const SkuMappingEntry = db.SkuMappingEntry
const OrderCustomProduct = db.orderCustomProduct
const { applyRulesToSku } = require('../utils/skuMigrate');

function mapLikeToPlain(obj) {
    if (!obj) return {};
    // Mongoose Map (non-lean) có .toObject?.()
    if (typeof obj.toObject === 'function') return obj.toObject();
    // Map native
    if (obj instanceof Map) return Object.fromEntries(obj);
    // Plain object
    if (typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return {};
}


/** Preview theo 1 configId (không ghi DB) */
exports.previewWithConfig = async (req, res) => {
    try {
        const { orderIds = [], configId } = req.body || {};
        if (!configId) return res.status(400).json({ message: 'Missing configId' });
        const cfg = await SkuMappingConfig.findById(configId).lean();
        if (!cfg) return res.status(404).json({ message: 'Config not found' });

        const q = {};
        if (orderIds.length) q.orderId = { $in: orderIds };

        const orders = await OrderCustomProduct.find(q).select('orderId items').lean();
        const out = [];
        for (const ord of orders) {
            for (const it of (ord.items || [])) {
                if (!it?.sku) continue;
                const r = applyRulesToSku(it.sku, {
                    employeeMap: Object.fromEntries(cfg.employeeMap || []),
                    productMap: Object.fromEntries(cfg.productMap || []),
                    ...cfg.options,
                });
                if (r.ok && r.changed) {
                    out.push({ orderId: ord.orderId, orderItemId: it.orderItemId, old: it.sku, next: r.next });
                }
            }
        }
        res.json({ totalChanges: out.length, samples: out.slice(0, 50) });
    } catch (e) { res.status(500).json({ message: 'Preview failed', error: e.message }); }
};

/** Apply: ghi log vào SkuMappingEntry (không sửa items[].sku) */
exports.applyConfigLogOnly = async (req, res) => {
    try {
        const { scope = {}, configId, source = 'bulk', dryRun = true } = req.body || {};
        if (!configId) return res.status(400).json({ message: 'Missing configId' });

        // load config
        const cfg = await SkuMappingConfig.findById(configId).lean();
        if (!cfg) return res.status(404).json({ message: 'Config not found' });

        // build rules
        const rules = {
            employeeMap: mapLikeToPlain(cfg.employeeMap),
            productMap: mapLikeToPlain(cfg.productMap),
            upperProduct: cfg?.options?.upperProduct !== false, // default true
            useToday: !!cfg?.options?.useToday,
            minSeqDigits: cfg?.options?.minSeqDigits ?? undefined,
            restrictEmployee: Array.isArray(cfg?.options?.restrictEmployee) ? cfg.options.restrictEmployee : [],
        };

        // scope query
        const q = {};
        if (Array.isArray(scope.orderIds) && scope.orderIds.length) q.orderId = { $in: scope.orderIds };
        if (scope.shopId) q.shopId = scope.shopId;
        if (scope.dateFrom || scope.dateTo) {
            q.createdAt = {};
            if (scope.dateFrom) q.createdAt.$gte = new Date(scope.dateFrom);
            if (scope.dateTo) q.createdAt.$lte = new Date(scope.dateTo);
        }

        const limitOrders = Number(req.body?.limitOrders || 0);

        // queues
        const logOps = [];      // SkuMappingEntry
        const orderOps = [];    // OrderCustomProduct (set items.$.mapped_sku)
        const samples = [];

        const cursor = OrderCustomProduct.find(q, { orderId: 1, items: 1 }).cursor();
        let ordersTouched = 0;
        let totalMapped = 0;

        for await (const ord of cursor) {
            let orderHasChanges = false;

            for (const it of (ord.items || [])) {
                if (!it?.sku) continue;

                const r = applyRulesToSku(it.sku, rules);
                if (r.ok && r.changed) {
                    orderHasChanges = true;
                    totalMapped++;

                    if (samples.length < 50) {
                        samples.push({
                            orderId: ord.orderId,
                            orderItemId: it.orderItemId,
                            old: it.sku,
                            next: r.next,
                        });
                    }

                    // 1) log mapping
                    logOps.push({
                        updateOne: {
                            filter: { orderId: ord.orderId, orderItemId: it.orderItemId, oldSku: it.sku, newSku: r.next },
                            update: {
                                $setOnInsert: {
                                    config_id: cfg._id,
                                    rulesSnapshot: rules,
                                    source,
                                    operator: req.user?._id || null,
                                    migratedAt: new Date(),
                                },
                            },
                            upsert: true,
                        },
                    });

                    // 2) set mapped_sku trên order.items
                    orderOps.push({
                        updateOne: {
                            filter: { orderId: ord.orderId, 'items.orderItemId': it.orderItemId },
                            update: { $set: { 'items.$.mapped_sku': r.next } },
                        },
                    });
                }
            }

            if (orderHasChanges) {
                ordersTouched++;
                if (limitOrders && ordersTouched >= limitOrders) break;
            }
        }

        // bulk writes (skip nếu dryRun)
        let logResult = 'skipped (dryRun=true)';
        let orderResult = 'skipped (dryRun=true)';

        if (!dryRun && logOps.length) {
            try {
                logResult = await SkuMappingEntry.bulkWrite(logOps, { ordered: false });
            } catch (err) {
                logResult = { error: 'bulkWrite logs failed', detail: err?.message };
            }
        }
        if (!dryRun && orderOps.length) {
            try {
                orderResult = await OrderCustomProduct.bulkWrite(orderOps, { ordered: false });
            } catch (err) {
                orderResult = { error: 'bulkWrite orders failed', detail: err?.message };
            }
        }

        return res.json({
            dryRun: !!dryRun,
            configId,
            ordersTouched,
            totalMapped,
            opsQueued: logOps.length,
            orderOpsQueued: orderOps.length,
            logResult,
            orderResult,
            samples,
        });
    } catch (e) {
        return res.status(500).json({ message: 'Apply failed', error: e.message });
    }
};

/** List & filter mapping logs */
exports.listMappings = async (req, res) => {
    try {
        const { orderId, configId, employeeOld, employeeNew, page = 1, perPage = 20 } = req.query;
        const q = {};
        if (orderId) q.orderId = orderId;
        if (configId) q.config_id = configId;
        if (employeeOld) q.oldSku = new RegExp(`^${employeeOld}-`, 'i');
        if (employeeNew) q.newSku = new RegExp(`^${employeeNew}-`, 'i');

        const skip = (Number(page) - 1) * Number(perPage);
        const [items, total] = await Promise.all([
            SkuMappingEntry.find(q).sort({ migratedAt: -1 }).skip(skip).limit(Number(perPage)).lean(),
            SkuMappingEntry.countDocuments(q),
        ]);
        res.json({ page: Number(page), perPage: Number(perPage), total, items });
    } catch (e) { res.status(500).json({ message: 'List mappings failed', error: e.message }); }
};
