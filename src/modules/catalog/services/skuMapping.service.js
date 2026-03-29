// src/modules/catalog/services/skuMapping.service.js
const SkuMappingConfig = require("../models/skuMappingConfig.model");
const SkuMappingEntry = require("../models/skuMappingEntry.model");
const OrderCustomProduct = require("../../order/models/order.model");

const {
    applyRulesToSku,
    buildRulesFromConfig,
} = require("../utils/skuMigrate");

const previewWithConfig = async (orderIds = [], configId) => {
    if (!configId) {
        const err = new Error("Missing configId");
        err.status = 400;
        throw err;
    }

    const cfg = await SkuMappingConfig.findById(configId).lean();
    if (!cfg) {
        const err = new Error("Config not found");
        err.status = 404;
        throw err;
    }

    const rules = buildRulesFromConfig(cfg);

    const q = {};
    if (orderIds.length) q.orderId = { $in: orderIds };

    const orders = await OrderCustomProduct.find(q)
        .select("orderId items")
        .lean();

    const out = [];
    for (const ord of orders) {
        for (const it of ord.items || []) {
            if (!it?.sku) continue;
            const r = applyRulesToSku(it.sku, rules);
            if (r.ok && r.changed) {
                out.push({
                    orderId: ord.orderId,
                    orderItemId: it.orderItemId,
                    old: it.sku,
                    next: r.next,
                });
            }
        }
    }
    return { totalChanges: out.length, samples: out.slice(0, 50) };
};

const applyConfigLogOnly = async (payload, user) => {
    const { scope = {}, configId, source = "bulk", dryRun = true } = payload || {};

    if (!configId) {
        const err = new Error("Missing configId");
        err.status = 400;
        throw err;
    }

    const cfg = await SkuMappingConfig.findById(configId).lean();
    if (!cfg) {
        const err = new Error("Config not found");
        err.status = 404;
        throw err;
    }

    const rules = buildRulesFromConfig(cfg);

    const q = {};
    if (Array.isArray(scope.orderIds) && scope.orderIds.length)
        q.orderId = { $in: scope.orderIds };
    if (scope.shopId) q.shopId = scope.shopId;
    if (scope.dateFrom || scope.dateTo) {
        q.createdAt = {};
        if (scope.dateFrom) q.createdAt.$gte = new Date(scope.dateFrom);
        if (scope.dateTo) q.createdAt.$lte = new Date(scope.dateTo);
    }

    const limitOrders = Number(payload?.limitOrders || 0);

    const logOps = [];
    const orderOps = [];
    const samples = [];

    const cursor = OrderCustomProduct.find(q, { orderId: 1, items: 1 }).cursor();
    let ordersTouched = 0;
    let totalMapped = 0;

    for await (const ord of cursor) {
        let orderHasChanges = false;

        for (const it of ord.items || []) {
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

                logOps.push({
                    updateOne: {
                        filter: {
                            orderId: ord.orderId,
                            orderItemId: it.orderItemId,
                            oldSku: it.sku,
                            newSku: r.next,
                        },
                        update: {
                            $setOnInsert: {
                                config_id: cfg._id,
                                rulesSnapshot: rules,
                                source,
                                operator: user?._id || null,
                                migratedAt: new Date(),
                            },
                        },
                        upsert: true,
                    },
                });

                orderOps.push({
                    updateOne: {
                        filter: { orderId: ord.orderId, "items.orderItemId": it.orderItemId },
                        update: { $set: { "items.$.mapped_sku": r.next } },
                    },
                });
            }
        }

        if (orderHasChanges) {
            ordersTouched++;
            if (limitOrders && ordersTouched >= limitOrders) break;
        }
    }

    let logResult = "skipped (dryRun=true)";
    let orderResult = "skipped (dryRun=true)";

    if (!dryRun && logOps.length) {
        try {
            logResult = await SkuMappingEntry.bulkWrite(logOps, { ordered: false });
        } catch (err) {
            logResult = { error: "bulkWrite logs failed", detail: err?.message };
        }
    }
    if (!dryRun && orderOps.length) {
        try {
            orderResult = await OrderCustomProduct.bulkWrite(orderOps, { ordered: false });
        } catch (err) {
            orderResult = { error: "bulkWrite orders failed", detail: err?.message };
        }
    }

    return {
        dryRun: !!dryRun,
        configId,
        ordersTouched,
        totalMapped,
        opsQueued: logOps.length,
        orderOpsQueued: orderOps.length,
        logResult,
        orderResult,
        samples,
    };
};

const listMappings = async (filters) => {
    const { orderId, configId, employeeOld, employeeNew, page = 1, perPage = 20 } = filters;
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
    return { page: Number(page), perPage: Number(perPage), total, items };
};

module.exports = {
    previewWithConfig,
    applyConfigLogOnly,
    listMappings,
};

