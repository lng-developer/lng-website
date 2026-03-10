// src/modules/system/controllers/realtimeLog.controller.js
const realtimeLogService = require('../services/realtimeLog.service');

async function addLog(req, res) {
    try {
        const {
            shopId,
            machineId,
            label,
            action = "click",
            level = "info",
            message,
        } = req.body || {};
        if (!shopId || !machineId || !message) {
            return res
                .status(400)
                .json({ ok: false, message: "shopId, machineId, message required" });
        }
        const row = await realtimeLogService.writeLog({
            shopId,
            machineId,
            label,
            action,
            level,
            message,
        });
        return res.json({ ok: true, logId: row._id });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
}

const appendLogs = async (req, res) => {
    try {
        const {
            shopId,
            machineId,
            label,
            action = "click",
            lines,
        } = req.body || {};
        if (!shopId || !machineId || !Array.isArray(lines) || !lines.length) {
            return res
                .status(400)
                .json({ ok: false, message: "shopId, machineId, lines[] required" });
        }

        const inserted = await realtimeLogService.appendLogs({
            shopId,
            machineId,
            label,
            action,
            lines
        });

        return res.json({ ok: true, inserted });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

const getListLog = async (req, res) => {
    try {
        const { machineId, limit, tzOffset } = req.query || {};

        const logs = await realtimeLogService.getListLog({
            machineId,
            limit,
            tzOffset
        });

        return res.json({ ok: true, logs });
    } catch (e) {
        return res.status(500).json({ ok: false, message: e.message });
    }
};

module.exports = { addLog, getListLog, appendLogs };

