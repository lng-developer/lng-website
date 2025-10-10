const db = require("../models");
const Job = db.Job;
const { configure } = require("../service/scheduler.service");
const { addLog } = require("../service/realtime.service");

exports.runNow = async (req, res) => {
  const every = Number(process.env.FIXED_EVERY_HOURS || 4);
  const toUTC = Date.now();
  const fromUTC = toUTC - every * 3600 * 1000;

  const job = await Job.create({
    type: "import",
    dueAt: toUTC,
    window: { from: fromUTC, to: toUTC },
  });
  await addLog("RUN_NOW", { jobId: String(job._id), reason: "manual" });
  return res.json({ ok: true, jobId: String(job._id) });
};

exports.schedule = async (req, res) => {
  const { enabled, everyHours, baseHour, tzMin } = req.body || {};
  const cfg = configure({ enabled, everyHours, baseHour, tzMin });

  await addLog("SYNC_CONFIG", {
    enabled: cfg.enabled,
    everyHours: cfg.everyHours,
    baseHour: cfg.baseHour,
    tzMin: cfg.tzMin,
  });
  return res.json({ ok: true, payload: cfg });
};
