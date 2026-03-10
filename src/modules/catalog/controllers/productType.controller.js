// src/modules/catalog/controllers/productType.controller.js
const productTypeService = require('../services/productType.service');

exports.getGroups = async (req, res) => {
    try {
        const result = await productTypeService.getGroups(req.query);
        res.json(result);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

exports.createGroup = async (req, res) => {
    try {
        const doc = await productTypeService.createGroup(req.body);
        res.status(201).json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};

exports.updateGroup = async (req, res) => {
    try {
        const doc = await productTypeService.updateGroup(req.params.groupId, req.body);
        res.json(doc);
    } catch (e) {
        if (e.status === 404) {
            return res.status(404).json({ message: e.message });
        }
        res.status(400).json({ message: e.message });
    }
};

exports.deleteGroup = async (req, res) => {
    try {
        await productTypeService.deleteGroup(req.params.groupId);
        res.json({ message: "Deleted" });
    } catch (e) {
        if (e.status === 404) {
            return res.status(404).json({ message: e.message });
        }
        res.status(400).json({ message: e.message });
    }
};

exports.addItem = async (req, res) => {
    try {
        const group = await productTypeService.addItem(req.params.groupId, req.body);
        res.json(group);
    } catch (e) {
        if (e.status === 404) {
            return res.status(404).json({ message: e.message });
        }
        res.status(400).json({ message: e.message });
    }
};

exports.updateItem = async (req, res) => {
    try {
        const group = await productTypeService.updateItem(req.params.groupId, req.params.itemId, req.body);
        res.json(group);
    } catch (e) {
        if (e.status === 404) {
            return res.status(404).json({ message: e.message });
        }
        res.status(400).json({ message: e.message });
    }
};

exports.deleteItem = async (req, res) => {
    try {
        const group = await productTypeService.deleteItem(req.params.groupId, req.params.itemId);
        res.json(group);
    } catch (e) {
        if (e.status === 404) {
            return res.status(404).json({ message: e.message });
        }
        res.status(400).json({ message: e.message });
    }
};

exports.reorderItems = async (req, res) => {
    try {
        const result = await productTypeService.reorderItems(req.params.groupId, req.body);
        res.json(result);
    } catch (e) {
        if (e.status === 404) {
            return res.status(404).json({ message: e.message });
        }
        res.status(400).json({ message: e.message });
    }
};

