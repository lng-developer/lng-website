const express = require("express");
const { realtimeLogController } = require("../controllers");
const router = express.Router();

// POST /api/ext-logs  (ghi 1 log)
router.post("/", async (req, res) => {
  try {
    const doc = await realtimeLogController.createExtLog(req.body || {});
    res.json({ ok: true, log: doc });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// POST /api/ext-logs/bulk  (ghi nhiều log cùng lúc)
router.post("/bulk", async (req, res) => {
  try {
    const { logs } = req.body || {};
    const result = await realtimeLogController.createExtLogsBulk(
      Array.isArray(logs) ? logs : []
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

// GET /api/ext-logs  (FE đọc log)
router.get("/", async (req, res) => {
  try {
    const result = await realtimeLogController.queryExtLogs({
      shopId: req.query.shopId,
      machineId: req.query.machineId,
      action: req.query.action,
      type: req.query.type,
      level: req.query.level,
      jobId: req.query.jobId,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit ? Number(req.query.limit) : 200,
      cursorTs: req.query.cursorTs,
      sort: req.query.sort || "desc",
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, message: e.message });
  }
});

module.exports = router;
