// src/modules/system/controllers/realtime.controller.js
const db = require("../../../models");
const RealtimeLog = db.RealtimeLog;
const { buildActivityLogsFromDB } = require("../services/realtimeLog.service");

const getActivityLogs = async (req, res) => {
    try {
        const {
            view,
            since,
            limit,
            sort = "asc",
            type,
            jobId,
            clientId,
        } = req.query;

        if (view === "activity") {
            const entries = await buildActivityLogsFromDB({
                since: since ? Number(since) : undefined,
                limit: limit ? Number(limit) : 200,
            });
            const nextSince = entries.length
                ? entries[entries.length - 1].ts
                : since
                    ? Number(since)
                    : Date.now();
            return res.json({ since: Number(since) || 0, nextSince, entries });
        }

        const q = {};
        if (type) q.type = type;
        if (jobId) q.jobId = jobId;
        if (clientId) q.$or = [{ clientId }, { label: clientId }];
        const rows = await RealtimeLog.find(q)
            .sort({ ts: sort === "desc" ? -1 : 1 })
            .limit(Math.min(Number(limit) || 200, 5000))
            .lean();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ ok: false, message: e.message });
    }
};

module.exports = {
    getActivityLogs
};

