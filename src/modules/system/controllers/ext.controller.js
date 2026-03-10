// src/modules/system/controllers/ext.controller.js
const extService = require('../services/ext.service');

const vendorSyncOne = async (req, res) => {
    try {
        const { orderId } = req.body || {};
        if (!orderId) {
            return res.status(400).json({ ok: false, message: "orderId required" });
        }
        const result = await extService.updateOrderByVendors(orderId);
        return res.json({ ok: true, orderId, ...result });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

const vendorSyncList = async (req, res) => {
    try {
        const { orderIds = [] } = req.body || {};
        if (!Array.isArray(orderIds) || !orderIds.length) {
            return res.status(400).json({ ok: false, message: "orderIds[] required" });
        }

        let ok = 0, fail = 0;
        const details = [];

        for (const id of orderIds) {
            try {
                const r = await extService.updateOrderByVendors(id);
                details.push({ orderId: id, ok: true, ...r });
                ok++;
            } catch (err) {
                details.push({ orderId: id, ok: false, message: err.message });
                fail++;
            }
        }

        return res.json({ ok: true, summary: { ok, fail, scanned: orderIds.length }, details });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

const vendorSyncBatch = async (req, res) => {
    try {
        const { max = 100, dryRun = false } = req.body || {};
        const result = await extService.runBatch({ max: Number(max) || 100, dryRun: Boolean(dryRun) });
        return res.json({ ok: true, ...result });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

const pullAllOrder = async (req, res) => {
    try {
        const { action = "click", label = null, type, payload } = req.body || {};
        const io = req.app.get("io");
        if (!io) return res.status(500).json({ ok: false, message: "io missing" });

        const recipients = await extService.pullAllOrder(io, action, label, type, payload);

        return res.status(202).json({
            ok: true,
            recipients,
            message: "Broadcast IMPORT_ORDERS to all connected extensions",
        });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

const requestExtension = async (req, res) => {
    try {
        const { shopId, machineId, action = "click", label = null, type, payload } = req.body || {};
        if (!shopId || !machineId) {
            return res.status(400).json({ ok: false, message: "shopId & machineId required" });
        }

        const io = req.app.get("io");
        if (!io) return res.status(500).json({ ok: false, message: "io missing" });

        await extService.requestExtension(io, shopId, machineId, action, label, type, payload);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

const getClientOnline = async (req, res) => {
    try {
        const presence = req.app.get("presence");
        const io = req.app.get("io");
        if (!io || !presence) return res.json({ ok: true, clients: [] });

        const { shopId: filterShopId, machineId: filterMachineId, q } = req.query || {};

        const clients = await extService.getClientOnline(io, presence, filterShopId, filterMachineId, q);

        return res.json(clients);
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

module.exports = {
    requestExtension,
    getClientOnline,
    pullAllOrder,
    vendorSyncOne,
    vendorSyncList,
    vendorSyncBatch,
};

