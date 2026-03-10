// src/modules/system/controllers/auditLog.controller.js
const auditLogService = require('../services/auditLog.service');

const listOrderHistory = async (req, res) => {
    try {
        const result = await auditLogService.listOrderHistory(req.query);
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Failed to fetch audit logs', error: err.message });
    }
};

const getOrderHistoryById = async (req, res) => {
    try {
        const data = await auditLogService.getOrderHistoryById(req.params.id);
        res.json(data);
    } catch (err) {
        res.status(err.status || 500).json({ message: 'Failed to fetch audit log detail', error: err.message });
    }
};

module.exports = {
    listOrderHistory,
    getOrderHistoryById
};

