const db = require("../models");
const RealtimeLog = db.RealtimeLog;
const Shop = db.shop;

// Lấy toàn bộ logs của NGÀY HÔM NAY, populate shop
const getLogs = async (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const items = await RealtimeLog.find({ day: today })
      .sort({ ts: -1 })
      .limit(500)
      .populate({ path: "shopId", select: "name store status" })
      .lean();

    res.json({ ok: true, day: today, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

// controllers/log.controller.js (hàm addLog)
const addLog = async (req, res) => {
  try {
    const {
      shopId,
      clientId,
      label,
      phase,
      phases,
      status,
      ms,
      error,
      trigger,
      meta,
    } = req.body || {};

    const logType =
      trigger === "AUTO" ? "AUTO" : trigger === "CLICK" ? "CLICK" : "STATUS";

    const normalizePhases = (p, s) => {
      if (Array.isArray(p))
        return p.map((x) => ({
          type: String(x.type).toLowerCase(),
          status: String(x.status || "running").toLowerCase(),
        }));
      if (p && typeof p === "object")
        return Object.entries(p).map(([k, v]) => ({
          type: k.toLowerCase(),
          status: String(v || "running").toLowerCase(),
        }));
      if (typeof p === "string" && p.trim())
        return [
          {
            type: p.trim().toLowerCase(),
            status: String(s || "running").toLowerCase(),
          },
        ];
      return [];
    };

    const phaseArr = normalizePhases(phases ?? phase, status);
    if (!phaseArr.length)
      return res
        .status(400)
        .json({ ok: false, message: "phase array required" });

    const vals = phaseArr.map((x) => x.status);
    const overall = vals.some((v) => v === "fail" || v === "error")
      ? "error"
      : vals.length && vals.every((v) => v === "success")
      ? "success"
      : "running";

    const ts = Date.now();

    await RealtimeLog.create({
      ts,
      type: logType,
      day: new Date(ts).toISOString().slice(0, 10),
      clientId: clientId || null,
      label: label || null,
      phase: phaseArr,
      status: overall,
      ms: Number.isFinite(ms) ? ms : undefined,
      error: error || undefined,
      // >>> LƯU TRỰC TIẾP SHOPID Ở TRƯỜNG MỚI
      shopId: shopId || undefined,
      // meta vẫn giữ cho dữ liệu phụ
      meta: meta && typeof meta === "object" ? meta : undefined,
    });

    if (shopId && label) {
      await Shop.updateOne(
        { _id: shopId },
        {
          $set: {
            "clients.$[c].lastSeen": new Date(),
            "clients.$[c].status": "online",
          },
        },
        { arrayFilters: [{ "c.label": label }] }
      ).catch(() => {});
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /ext/log error:", e);
    res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = { getLogs, addLog };
