const cron = require("node-cron");
const { runEtsyVendorBatch } = require("../controllers/ext.controller");

const DEFAULT_CRON = "0 * * * *";
const DEFAULT_MAX = 1100;
const DEFAULT_STATUS = "Fulfilled";

let job = null;
let running = false;

function isDisabled() {
  return String(process.env.ETSY_VENDOR_SYNC_CRON_DISABLED || "").toLowerCase() === "true";
}

function getConfig() {
  return {
    cronPattern: process.env.ETSY_VENDOR_SYNC_CRON || DEFAULT_CRON,
    max: Number(process.env.ETSY_VENDOR_SYNC_MAX || DEFAULT_MAX) || DEFAULT_MAX,
    status: process.env.ETSY_VENDOR_SYNC_STATUS || DEFAULT_STATUS,
  };
}

async function runOnce(source = "manual") {
  if (running) {
    return { skipped: true, reason: "previous job still running" };
  }

  running = true;
  const config = getConfig();

  try {
    return await runEtsyVendorBatch({
      max: config.max,
      dryRun: false,
      status: config.status,
    });
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    running = false;
  }
}

function start() {
  if (isDisabled()) {
    return null;
  }

  if (job) return job;

  const { cronPattern } = getConfig();
  if (!cron.validate(cronPattern)) {
    return null;
  }

  job = cron.schedule(
    cronPattern,
    () => {
      runOnce("cron");
    },
    { scheduled: true, timezone: "Asia/Ho_Chi_Minh" }
  );

  return job;
}

function stop() {
  if (!job) return;
  job.stop();
  job = null;
}

module.exports = {
  start,
  stop,
  runOnce,
};
