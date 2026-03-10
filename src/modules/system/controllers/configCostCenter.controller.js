// src/modules/system/controllers/configCostCenter.controller.js
const configCostCenterService = require('../services/configCostCenter.service');

const createConfig = async (req, res) => {
    try {
        const data = await configCostCenterService.createConfig(req.body, req.user);
        res.status(201).json({ message: 'Created', data });
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Create failed', error: err.message });
    }
};

const listConfigs = async (req, res) => {
    try {
        const result = await configCostCenterService.listConfigs(req.query);
        res.json({ message: 'OK', ...result });
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Fetch failed', error: err.message });
    }
};

const getConfig = async (req, res) => {
    try {
        const data = await configCostCenterService.getConfig(req.params.id);
        res.json({ message: 'OK', data });
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Get failed', error: err.message });
    }
};

const updateConfig = async (req, res) => {
    try {
        const data = await configCostCenterService.updateConfig(req.params.id, req.body, req.user);
        res.json({ message: 'Updated', data });
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Update failed', error: err.message });
    }
};

const toggleStatus = async (req, res) => {
    try {
        const data = await configCostCenterService.toggleStatus(req.params.id, req.body.status, req.user);
        res.json({ message: 'Toggled', data });
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Toggle failed', error: err.message });
    }
};

const toggleFlags = async (req, res) => {
    try {
        const data = await configCostCenterService.toggleFlags(req.params.id, req.body, req.user);
        res.json({ message: 'Flags updated', data });
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Toggle flags failed', error: err.message });
    }
};

const removeConfig = async (req, res) => {
    try {
        const id = await configCostCenterService.removeConfig(req.params.id, req.user);
        res.json({ message: 'Deleted', data: id });
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Delete failed', error: err.message });
    }
};

module.exports = {
    createConfig,
    listConfigs,
    getConfig,
    updateConfig,
    toggleStatus,
    toggleFlags,
    removeConfig
};

