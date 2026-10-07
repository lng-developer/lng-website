const cron = require("node-cron");
const { runViettelPostTrackingSync } = require("./viettelPostTrackingSync.service");

const DEFAULT_CRON = "*/30 * * * *";
let job = null;
let running = false;

function isEnabled() {
  return String(process.env.VIETTELPOST_TRACKING_POLL_ENABLED || "").toLowerCase() === "true";
}

function getConfig() {
  return {
    cronPattern: process.env.VIETTELPOST_TRACKING_POLL_CRON || DEFAULT_CRON,
    sinceDays: Number(process.env.VIETTELPOST_TRACKING_POLL_DAYS || 7),
    max: Number(process.env.VIETTELPOST_TRACKING_POLL_MAX || 1000),
  };
}

async function runOnce() {
  if (running) return { skipped: true, reason: "previous job still running" };
  if (!isEnabled()) return { skipped: true, reason: "Viettel Post tracking poll is disabled" };
  running = true;
  try {
    const { sinceDays, max } = getConfig();
    return await runViettelPostTrackingSync({ sinceDays, max, apply: true });
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    running = false;
  }
}

function start() {
  if (!isEnabled() || job) return job;
  const { cronPattern } = getConfig();
  if (!cron.validate(cronPattern)) return null;
  job = cron.schedule(cronPattern, () => { runOnce(); }, { scheduled: true, timezone: "Asia/Ho_Chi_Minh" });
  return job;
}

function stop() {
  if (!job) return;
  job.stop();
  job = null;
}

module.exports = { start, stop, runOnce };
