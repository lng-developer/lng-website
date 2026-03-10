// src/modules/catalog/controllers/skuMapping.controller.js
const skuMappingService = require('../services/skuMapping.service');

exports.previewWithConfig = async (req, res) => {
    try {
        const { orderIds = [], configId } = req.body || {};
        const result = await skuMappingService.previewWithConfig(orderIds, configId);
        res.json(result);
    } catch (e) {
        if (e.status) {
            return res.status(e.status).json({ message: e.message });
        }
        res.status(500).json({ message: "Preview failed", error: e.message });
    }
};

exports.applyConfigLogOnly = async (req, res) => {
    try {
        const result = await skuMappingService.applyConfigLogOnly(req.body, req.user);
        res.json(result);
    } catch (e) {
        if (e.status) {
            return res.status(e.status).json({ message: e.message });
        }
        res.status(500).json({ message: "Apply failed", error: e.message });
    }
};

exports.listMappings = async (req, res) => {
    try {
        const result = await skuMappingService.listMappings(req.query);
        res.json(result);
    } catch (e) {
        res.status(500).json({ message: "List mappings failed", error: e.message });
    }
};

