const db = require("../models");
const SkuMappingConfig = db.SkuMappingConfig;
const SkuMappingEntry = db.SkuMappingEntry;
const OrderCustomProduct = db.orderCustomProduct;
const EtsyOrder = db.EtsyOrder;
const User = db.user;

const {
    applyRulesToSku,
    buildRulesFromConfig,
} = require("../utils/skuMigrate");

const ETSY_ORDER_ID_RE = /^\d+$/;

function splitOrderIdsByMarketplace(orderIds = []) {
    const amazon = [];
    const etsy = [];

    for (const orderId of orderIds) {
        const value = String(orderId || "").trim();
        if (!value) continue;
        if (ETSY_ORDER_ID_RE.test(value)) etsy.push(value);
        else amazon.push(value);
    }

    return { amazon, etsy };
}

function buildScopedQueries(scope = {}) {
    const base = {};
    if (scope.shopId) base.shopId = scope.shopId;
    if (scope.dateFrom || scope.dateTo) {
        base.createdAt = {};
        if (scope.dateFrom) base.createdAt.$gte = new Date(scope.dateFrom);
        if (scope.dateTo) base.createdAt.$lte = new Date(scope.dateTo);
    }

    const orderIds = Array.isArray(scope.orderIds) ? scope.orderIds : [];
    if (!orderIds.length) {
        return {
            amazon: { ...base },
            etsy: { ...base },
        };
    }

    const split = splitOrderIdsByMarketplace(orderIds);
    return {
        amazon: split.amazon.length ? { ...base, orderId: { $in: split.amazon } } : null,
        etsy: split.etsy.length ? { ...base, orderId: { $in: split.etsy } } : null,
    };
}

function getOrderSources(queries = {}) {
    return [
        {
            marketplace: "amazon",
            Model: OrderCustomProduct,
            query: queries.amazon,
            itemIdField: "orderItemId",
        },
        {
            marketplace: "etsy",
            Model: EtsyOrder,
            query: queries.etsy,
            itemIdField: "transactionId",
        },
    ].filter((sourceInfo) => sourceInfo.Model && sourceInfo.query);
}

function getItemId(item, primaryField) {
    return item?.[primaryField] || item?.orderItemId || item?.transactionId || "";
}

function getSellerCodeFromSku(sku) {
    const first = String(sku || "").trim().split("-")[0]?.trim();
    return first || null;
}

async function buildSellerUpdateFromSku(orderId, sku) {
    const sellerCode = getSellerCodeFromSku(sku);
    if (!orderId || !sellerCode || !User?.findOne) return null;

    const user = await User.findOne({ employee_id: sellerCode }).lean();
    const $set = { "seller.sellerCode": sellerCode };
    if (user?._id) $set["seller.sellerId"] = user._id;

    return {
        updateOne: {
            filter: { orderId },
            update: { $set },
        },
    };
}

exports.previewWithConfig = async (req, res) => {
    try {
        const { orderIds = [], configId } = req.body || {};
        if (!configId) return res.status(400).json({ message: "Missing configId" });

        const cfg = await SkuMappingConfig.findById(configId).lean();
        if (!cfg) return res.status(404).json({ message: "Config not found" });

        const rules = buildRulesFromConfig(cfg);
        const queries = buildScopedQueries({ orderIds });
        const out = [];

        for (const sourceInfo of getOrderSources(queries)) {
            const orders = await sourceInfo.Model.find(sourceInfo.query, { orderId: 1, items: 1 }).lean();

            for (const ord of orders) {
                for (const it of ord.items || []) {
                    if (!it?.sku) continue;

                    const r = applyRulesToSku(it.sku, rules);
                    const orderItemId = getItemId(it, sourceInfo.itemIdField);
                    if (r.ok && r.changed && orderItemId) {
                        out.push({
                            orderId: ord.orderId,
                            orderItemId,
                            old: it.sku,
                            next: r.next,
                            marketplace: sourceInfo.marketplace,
                        });
                    }
                }
            }
        }

        res.json({ totalChanges: out.length, samples: out.slice(0, 50) });
    } catch (e) {
        res.status(500).json({ message: "Preview failed", error: e.message });
    }
};

exports.applyConfigLogOnly = async (req, res) => {
    try {
        const { scope = {}, configId, source = "bulk", dryRun = true } = req.body || {};
        if (!configId) return res.status(400).json({ message: "Missing configId" });

        const cfg = await SkuMappingConfig.findById(configId).lean();
        if (!cfg) return res.status(404).json({ message: "Config not found" });

        const rules = buildRulesFromConfig(cfg);
        const queries = buildScopedQueries(scope);
        const limitOrders = Number(req.body?.limitOrders || 0);

        const logOps = [];
        const orderOpsByMarketplace = {
            amazon: [],
            etsy: [],
        };
        const etsySellerSkuByOrderId = new Map();
        const samples = [];
        const marketplaces = {
            amazon: { ordersTouched: 0, totalMapped: 0, orderOpsQueued: 0 },
            etsy: { ordersTouched: 0, totalMapped: 0, orderOpsQueued: 0 },
        };

        let ordersTouched = 0;
        let totalMapped = 0;

        for (const sourceInfo of getOrderSources(queries)) {
            if (limitOrders && ordersTouched >= limitOrders) break;

            const cursor = sourceInfo.Model.find(sourceInfo.query, { orderId: 1, items: 1 }).cursor();
            for await (const ord of cursor) {
                let orderHasChanges = false;

                for (const it of ord.items || []) {
                    if (!it?.sku) continue;

                    const r = applyRulesToSku(it.sku, rules);
                    const orderItemId = getItemId(it, sourceInfo.itemIdField);
                    if (r.ok && r.changed && orderItemId) {
                        orderHasChanges = true;
                        totalMapped++;
                        marketplaces[sourceInfo.marketplace].totalMapped++;

                        if (samples.length < 50) {
                            samples.push({
                                orderId: ord.orderId,
                                orderItemId,
                                old: it.sku,
                                next: r.next,
                                marketplace: sourceInfo.marketplace,
                            });
                        }

                        logOps.push({
                            updateOne: {
                                filter: {
                                    orderId: ord.orderId,
                                    orderItemId,
                                    oldSku: it.sku,
                                    newSku: r.next,
                                },
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

                        orderOpsByMarketplace[sourceInfo.marketplace].push({
                            updateOne: {
                                filter: {
                                    orderId: ord.orderId,
                                    [`items.${sourceInfo.itemIdField}`]: orderItemId,
                                },
                                update: { $set: { "items.$.mapped_sku": r.next } },
                            },
                        });
                        if (sourceInfo.marketplace === "etsy") {
                            etsySellerSkuByOrderId.set(ord.orderId, r.next);
                        }
                    }
                }

                if (orderHasChanges) {
                    ordersTouched++;
                    marketplaces[sourceInfo.marketplace].ordersTouched++;
                    if (limitOrders && ordersTouched >= limitOrders) break;
                }
            }
        }

        marketplaces.amazon.orderOpsQueued = orderOpsByMarketplace.amazon.length;
        marketplaces.etsy.orderOpsQueued = orderOpsByMarketplace.etsy.length;
        const itemOrderOpsQueued = orderOpsByMarketplace.amazon.length + orderOpsByMarketplace.etsy.length;

        for (const [orderId, sku] of etsySellerSkuByOrderId.entries()) {
            const sellerUpdate = await buildSellerUpdateFromSku(orderId, sku);
            if (sellerUpdate) orderOpsByMarketplace.etsy.push(sellerUpdate);
        }

        let logResult = "skipped (dryRun=true)";
        let orderResult = "skipped (dryRun=true)";
        const orderResults = {
            amazon: dryRun ? "skipped (dryRun=true)" : "skipped (no ops)",
            etsy: dryRun ? "skipped (dryRun=true)" : "skipped (no ops)",
        };

        if (!dryRun && logOps.length) {
            try {
                logResult = await SkuMappingEntry.bulkWrite(logOps, { ordered: false });
            } catch (err) {
                logResult = { error: "bulkWrite logs failed", detail: err?.message };
            }
        }

        if (!dryRun && orderOpsByMarketplace.amazon.length) {
            try {
                orderResults.amazon = await OrderCustomProduct.bulkWrite(orderOpsByMarketplace.amazon, { ordered: false });
            } catch (err) {
                orderResults.amazon = { error: "bulkWrite amazon orders failed", detail: err?.message };
            }
        }

        if (!dryRun && orderOpsByMarketplace.etsy.length) {
            try {
                orderResults.etsy = await EtsyOrder.bulkWrite(orderOpsByMarketplace.etsy, { ordered: false });
            } catch (err) {
                orderResults.etsy = { error: "bulkWrite etsy orders failed", detail: err?.message };
            }
        }

        if (!dryRun) {
            orderResult = orderResults.amazon !== "skipped (dryRun=true)"
                ? orderResults.amazon
                : orderResults.etsy;
        }

        return res.json({
            dryRun: !!dryRun,
            configId,
            ordersTouched,
            totalMapped,
            opsQueued: logOps.length,
            orderOpsQueued: itemOrderOpsQueued,
            logResult,
            orderResult,
            orderResults,
            marketplaces,
            samples,
        });
    } catch (e) {
        return res.status(500).json({ message: "Apply failed", error: e.message });
    }
};

exports.listMappings = async (req, res) => {
    try {
        const { orderId, configId, employeeOld, employeeNew, page = 1, perPage = 20 } = req.query;
        const q = {};
        if (orderId) q.orderId = orderId;
        if (configId) q.config_id = configId;
        if (employeeOld) q.oldSku = new RegExp(`^${employeeOld}-`, "i");
        if (employeeNew) q.newSku = new RegExp(`^${employeeNew}-`, "i");

        const skip = (Number(page) - 1) * Number(perPage);
        const [items, total] = await Promise.all([
            SkuMappingEntry.find(q).sort({ migratedAt: -1 }).skip(skip).limit(Number(perPage)).lean(),
            SkuMappingEntry.countDocuments(q),
        ]);
        res.json({ page: Number(page), perPage: Number(perPage), total, items });
    } catch (e) {
        res.status(500).json({ message: "List mappings failed", error: e.message });
    }
};
