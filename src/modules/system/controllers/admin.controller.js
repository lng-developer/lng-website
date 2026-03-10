// src/modules/system/controllers/admin.controller.js
const adminService = require('../services/admin.service');

const invalidateAllSessions = async (req, res) => {
    try {
        const result = await adminService.invalidateAllSessions();
        res.json(result);
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to invalidate sessions' });
    }
};

module.exports = {
    invalidateAllSessions
};

