const cron = require("node-cron");

const DEFAULT_CRON = "5 * * * *";
const DEFAULT_TIMEOUT_MS = 30000;
let job = null;
let running = false;

function isDisabled() {
  return String(process.env.FULFILLMENT_TRACKING_PULL_CRON_DISABLED || "").toLowerCase() === "true";
}

function getConfig() {
  return {
    apiBaseUrl: String(process.env.FULFILLMENT_API_BASE_URL || "").trim().replace(/\/+$/, ""),
    tenantApiKey: String(process.env.FULFILLMENT_TENANT_API_KEY || "").trim(),
    cronPattern: process.env.FULFILLMENT_TRACKING_PULL_CRON || DEFAULT_CRON,
    timeoutMs: Number(process.env.FULFILLMENT_TRACKING_PULL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

async function runOnce() {
  if (running) return { skipped: true, reason: "previous job still running" };
  const config = getConfig();
  if (!config.apiBaseUrl || !config.tenantApiKey) {
    return { skipped: true, reason: "Fulfillment Platform configuration is missing" };
  }

  running = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.apiBaseUrl}/api/portal/tracking/pull`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.tenantApiKey}` },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.success) {
      throw new Error(payload?.error?.message || `Fulfillment tracking pull failed (${response.status})`);
    }
    return payload.data;
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    clearTimeout(timeout);
    running = false;
  }
}

function start() {
  if (isDisabled() || job) return job;
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
