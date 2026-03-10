// src/modules/system/controllers/points.controller.js
const pointsService = require('../services/points.service');

async function award(req, res) {
    try {
        const result = await pointsService.awardPoints(req.body);
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
}

async function getBalance(req, res) {
    try {
        const result = await pointsService.getBalance(req.params.userId, req.query);
        res.json({ success: true, ...result });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ success: false, message: e.message });
        res.status(500).json({ success: false, message: e.message });
    }
}

async function getByDay(req, res) {
    try {
        const result = await pointsService.getByDay(req.params.userId, req.query);
        res.json({ success: true, ...result });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ success: false, message: e.message });
        res.status(400).json({ success: false, message: e.message });
    }
}

async function getRange(req, res) {
    try {
        const result = await pointsService.getRange(req.params.userId, req.query);
        res.json({ success: true, ...result });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ success: false, message: e.message });
        res.status(400).json({ success: false, message: e.message });
    }
}

async function getLogs(req, res) {
    try {
        const logs = await pointsService.getLogs(req.params.userId, req.query);
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}

async function getAllWithLogs(req, res) {
    try {
        const result = await pointsService.getAllWithLogs(req.query);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
}

module.exports = {
    award,
    getBalance,
    getByDay,
    getRange,
    getLogs,
    getAllWithLogs
};

