const RealtimeLog = require("../models/realtimeLog.model");

let g_io = null;
const sseClients = new Set();
const liveBuffer = [];

function setIo(io) {
    g_io = io;
}

function makeActivityEntryFromDoc(doc) {
    if (!doc) return null;
    return {
        ts: doc.ts ? new Date(doc.ts).getTime() : Date.now(),
        type: doc.type || "unknown",
        phase: doc.phase,
        status: doc.status,
        socketId: doc.socketId,
        data: doc.meta || doc.data || {},
    };
}

async function addLog(type, data = {}) {
    try {
        const entry = { ts: new Date(), type, data };
        liveBuffer.push(entry);
        if (liveBuffer.length > 500) liveBuffer.shift();

        // Broadcast SSE
        const activity = makeActivityEntryFromDoc(entry);
        const packet = `data: ${JSON.stringify(activity)}\n\n`;
        sseClients.forEach((c) => {
            try {
                c.res.write(packet);
                c.res.flushHeaders?.();
            } catch (err) { }
        });

        // Save to DB if important or always? 
        // Original code seemed to just keep in memory for SSE but let's check if it saved.
        // Looking at the old code, it didn't seem to save everything to RealtimeLog automatically here,
        // but the RealtimeLog model exists for a reason.
    } catch (err) {
        console.error("addLog error:", err);
    }
}

async function buildActivityLogsFromDB({ since, limit = 200 } = {}) {
    const q = {};
    if (since) q.ts = { $gt: new Date(since) };
    const rows = await RealtimeLog.find(q).sort({ ts: -1 }).limit(limit).lean();
    return rows.reverse().map((r) => ({
        ts: new Date(r.ts).getTime(),
        type: r.type || "db_log",
        message: r.message,
        label: r.label,
        action: r.action,
        data: r,
    }));
}

async function buildPhaseSnapshotFromDB() {
    return {};
}

function sseStream(req, res) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const first = liveBuffer
        .slice(-50)
        .map((e) => {
            const fake = {
                ts: e.ts,
                type: e.type,
                phase: e.data?.phase,
                status: e.data?.status,
                socketId: e.data?.socketId,
                meta: e.data,
            };
            return makeActivityEntryFromDoc(fake);
        })
        .filter(Boolean);
    res.write(`data: ${JSON.stringify({ bootstrap: first })}\n\n`);

    const hb = setInterval(() => {
        try {
            res.write(`: ping ${Date.now()}\n\n`);
        } catch { }
    }, 15000);
    const client = { res, hb };
    sseClients.add(client);
    req.on("close", () => {
        clearInterval(hb);
        sseClients.delete(client);
        try {
            res.end();
        } catch { }
    });
}

async function writeLog({
    shopId,
    machineId,
    label = null,
    action = "click",
    level = "info",
    message,
}) {
    return RealtimeLog.create({
        shopId,
        machineId,
        label,
        action,
        level,
        message,
        ts: new Date(),
    });
}

const appendLogs = async ({ shopId, machineId, label, action = "click", lines }) => {
    if (!Array.isArray(lines) || !lines.length) return 0;

    const docs = lines
        .filter((l) => l && l.message)
        .map((l) => ({
            shopId,
            machineId,
            label: label || null,
            action,
            level: l.level || "info",
            message: String(l.message),
            ts: l.at ? new Date(l.at) : new Date(),
        }));

    if (!docs.length) return 0;
    await RealtimeLog.insertMany(docs, { ordered: false });
    return docs.length;
};

const getListLog = async ({ machineId, limit = 500, tzOffset }) => {
    const now = new Date();
    let start, end;

    if (tzOffset !== undefined) {
        const offsetMin = parseInt(tzOffset, 10) || 0;
        const nowShifted = new Date(now.getTime() + offsetMin * 60000);
        const startShifted = new Date(nowShifted);
        startShifted.setHours(0, 0, 0, 0);
        start = new Date(startShifted.getTime() - offsetMin * 60000);
        end = now;
    } else {
        start = new Date(now);
        start.setHours(0, 0, 0, 0);
        end = now;
    }

    const where = { ts: { $gte: start, $lte: end } };
    if (machineId) where.machineId = String(machineId);

    const rows = await RealtimeLog.find(where)
        .populate("shopId", "name")
        .limit(Math.min(Number(limit) || 500, 1000))
        .lean();

    return rows.map((r) => ({
        at: +new Date(r.ts),
        shop: r.shopId
            ? {
                shopName: r.shopId.name,
            }
            : null,
        machineId: r.machineId,
        label: r.label || null,
        action: r.action,
        level: r.level,
        message: r.message,
    }));
};

module.exports = {
    setIo,
    addLog,
    buildActivityLogsFromDB,
    buildPhaseSnapshotFromDB,
    sseStream,
    writeLog,
    appendLogs,
    getListLog
};
