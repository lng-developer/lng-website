const db = require("../models");
const RealtimeLog = db.RealtimeLog;
const Shop = db.shop;

const getLogs = async (req, res) => {
  try {
    const {
      day,
      from,
      to,
      clientId,
      jobId,
      phase,
      status,
      type = "STATUS", // vẫn giữ default nếu bạn đang dùng
      limit = 500,
      sort = "asc",
    } = req.query;

    const q = {};
    if (type && type !== "ALL") q.type = type; // cho phép truyền type=ALL để bỏ lọc
    if (day) q.day = day;
    if (from || to) {
      q.ts = {};
      if (from) q.ts.$gte = Number(from);
      if (to) q.ts.$lte = Number(to);
    }
    if (clientId) q.$or = [{ clientId }, { label: clientId }];
    if (jobId) q.jobId = jobId;
    if (phase) q.phase = phase;
    if (status) q.status = status;

    const docs = await RealtimeLog.find(q)
      .sort({ ts: sort === "desc" ? -1 : 1 })
      .limit(Math.min(Number(limit) || 500, 5000))
      .populate({
        path: "shopId",
        select: "store name status", // muốn thêm gì thì bổ sung ở đây
      })
      .lean();

    // Trả về nguyên vẹn; shop đã nằm trong field shopId (đã populate)
    res.json({ ok: true, count: docs.length, items: docs });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

const addLog = async (req, res) => {
  try {
    const {
      shopId,
      clientId, // giữ để tương thích
      label, // tên máy (Machine-xxxx)
      phase, // có thể là mảng mới / object cũ / string cũ
      phases, // nếu FE gửi field 'phases' thì cũng nhận
      status, // overall (có thể bỏ, sẽ tự tính)
      ms,
      error,
      trigger, // 'AUTO' | 'CLICK' (mới)
      meta, // extra
    } = req.body || {};

    // --- chuẩn hoá type (field 'type' trong log) ---
    const logType =
      trigger === "AUTO" ? "AUTO" : trigger === "CLICK" ? "CLICK" : "STATUS";

    // --- chuẩn hoá về mảng [{type, status}] ---
    const normalizePhases = (p, s) => {
      // Nếu đã là mảng đúng định dạng
      if (Array.isArray(p)) {
        return p
          .filter((x) => x && typeof x.type === "string")
          .map((x) => ({
            type: String(x.type).toLowerCase(),
            status: String(x.status || "running").toLowerCase(),
          }));
      }

      // Nếu là object: { import:'success', report:'fail', ads:'success' }
      if (p && typeof p === "object") {
        const out = [];
        for (const [k, v] of Object.entries(p)) {
          out.push({
            type: String(k).toLowerCase(),
            status: String(v || "running").toLowerCase(),
          });
        }
        return out;
      }

      // Nếu là string cũ: phase='import' (kèm status tổng quát s)
      if (typeof p === "string" && p.trim()) {
        return [
          {
            type: p.trim().toLowerCase(),
            status: String(s || "running").toLowerCase(),
          },
        ];
      }

      // không có gì hợp lệ
      return [];
    };

    const phaseArr = normalizePhases(phases ?? phase, status);

    if (!phaseArr.length) {
      return res
        .status(400)
        .json({ ok: false, message: "phase array required" });
    }

    // --- tính overall ---
    const vals = phaseArr.map((x) => x.status);
    const hasError = vals.some((v) => v === "fail" || v === "error");
    const allSuccess = vals.length > 0 && vals.every((v) => v === "success");
    const overall = hasError ? "error" : allSuccess ? "success" : "running";

    const ts = Date.now();

    await RealtimeLog.create({
      ts,
      type: logType, // 'AUTO' | 'CLICK' | 'STATUS'
      day: new Date(ts).toISOString().slice(0, 10),
      clientId: clientId || null,
      label: label || null,
      phase: phaseArr, // <-- LƯU DƯỚI DẠNG MẢNG
      status: overall, // overall dựa trên mảng phases
      ms: Number.isFinite(ms) ? ms : undefined,
      error: error || undefined,
      meta: {
        shopId: shopId || null,
        ...(meta && typeof meta === "object" ? meta : {}),
      },
    });

    // Cập nhật trạng thái client trong Shop (dựa theo shopId + label)
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

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /ext/log error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = { getLogs, addLog };
