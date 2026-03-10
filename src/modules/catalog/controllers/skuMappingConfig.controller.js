// src/modules/catalog/controllers/skuMappingConfig.controller.js
const skuMappingConfigService = require('../services/skuMappingConfig.service');

exports.createConfig = async (req, res) => {
    try {
        const cfg = await skuMappingConfigService.createConfig(req.body, req.user);
        res.json(cfg);
    } catch (e) {
        res.status(500).json({ message: 'Create config failed', error: e.message });
    }
};

exports.updateConfig = async (req, res) => {
    try {
        const cfg = await skuMappingConfigService.updateConfig(req.params.id, req.body, req.user);
        res.json(cfg);
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        res.status(500).json({ message: 'Update config failed', error: e.message });
    }
};

exports.listConfigs = async (req, res) => {
    try {
        const items = await skuMappingConfigService.listConfigs(req.query.active, req.query.q);
        res.json(items);
    } catch (e) {
        res.status(500).json({ message: 'List failed', error: e.message });
    }
};

exports.toggleActive = async (req, res) => {
    try {
        const cfg = await skuMappingConfigService.toggleActive(req.params.id, req.body.is_active, req.user);
        res.json(cfg);
    } catch (e) {
        if (e.status) return res.status(e.status).json({ message: e.message });
        res.status(500).json({ message: 'Toggle failed', error: e.message });
    }
};

exports.getActiveConfigs = async (req, res) => {
    try {
        const items = await skuMappingConfigService.getActiveConfigs();
        res.json(items);
    } catch (e) {
        res.status(500).json({ message: 'Get active failed', error: e.message });
    }
};

