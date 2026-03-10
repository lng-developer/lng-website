// src/modules/system/controllers/configOptionMapping.controller.js
const configOptionMappingService = require('../services/configOptionMapping.service');

const createMappings = async (req, res) => {
    try {
        const result = await configOptionMappingService.createMappings(req.body);
        return res.json({
            message: 'Created',
            ...result
        });
    } catch (err) {
        return res.status(err.status || 500).json({
            message: err.message || 'Create failed',
            errors: err.errors
        });
    }
};

const upsertMapping = async (req, res) => {
    try {
        const data = await configOptionMappingService.upsertMapping(req.body);
        return res.json({ message: 'Upserted', data });
    } catch (err) {
        return res.status(err.status || 500).json({
            message: err.message || 'Upsert failed',
            errors: err.errors
        });
    }
};

const listMappings = async (req, res) => {
    try {
        const result = await configOptionMappingService.listMappings(req.query);
        return res.json(result);
    } catch (err) {
        return res.status(500).json({ message: 'List failed', error: err.message });
    }
};

const getMappingById = async (req, res) => {
    try {
        const doc = await configOptionMappingService.getMappingById(req.params.id);
        return res.json(doc);
    } catch (err) {
        return res.status(err.status || 500).json({ message: 'Get failed', error: err.message });
    }
};

const updateMappingById = async (req, res) => {
    try {
        const doc = await configOptionMappingService.updateMappingById(req.params.id, req.body);
        return res.json({ message: 'Updated', data: doc });
    } catch (err) {
        return res.status(err.status || 500).json({ message: 'Update failed', error: err.message });
    }
};

const toggleActive = async (req, res) => {
    try {
        const doc = await configOptionMappingService.toggleActive(req.params.id, req.body.active);
        return res.json({ message: 'Toggled', data: doc });
    } catch (err) {
        return res.status(err.status || 500).json({ message: 'Toggle failed', error: err.message });
    }
};

const removeMapping = async (req, res) => {
    try {
        const doc = await configOptionMappingService.removeMapping(req.params.id);
        return res.json({ message: 'Soft deleted (active=false)', data: doc });
    } catch (err) {
        return res.status(err.status || 500).json({ message: 'Delete failed', error: err.message });
    }
};

const testMapping = async (req, res) => {
    try {
        const result = await configOptionMappingService.testMapping(req.body);
        return res.json(result);
    } catch (err) {
        return res.status(err.status || 500).json({ message: 'Test failed', error: err.message });
    }
};

module.exports = {
    createMappings,
    upsertMapping,
    listMappings,
    getMappingById,
    updateMappingById,
    toggleActive,
    removeMapping,
    testMapping
};

