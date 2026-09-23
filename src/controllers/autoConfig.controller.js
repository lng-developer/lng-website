const AutoConfig = require("../models/autoConfig.model");
const { vendorSyncBatch } = require("./ext.controller");
const Shop = require("../models/shop.model");
const { emitTaskToMachine, buildTaskId } = require("../lib/taskEmitter");

// Map lưu các cron jobs đang chạy: configId → cron job
const activeJobs = new Map();

/**
 * Khởi động scheduler tự động theo config PULL_TRACKING
 * Gọi hàm này 1 lần khi server start
 */
async function startAutoScheduler(io) {
  console.log(`\n⏰ [AUTO_SCHEDULER] Initializing scheduler...`);

  try {
    const configs = await AutoConfig.find({ status: true });
    console.log(`📋 [AUTO_SCHEDULER] Found ${configs.length} active config(s)`);

    for (const config of configs) {
      scheduleJob(config, io);
    }

    console.log(`✅ [AUTO_SCHEDULER] Scheduler initialized with ${activeJobs.size} job(s)\n`);
  } catch (err) {
    console.error(`❌ [AUTO_SCHEDULER] Failed to initialize:`, err.message);
  }
}

/**
 * Schedule 1 job theo config
 */
function nextRunAt(minutes, now = new Date()) {
  const intervalMs = Math.max(1, Number(minutes) || 60) * 60 * 1000;
  return new Date((Math.floor(now.getTime() / intervalMs) + 1) * intervalMs);
}

function normalizeScheduleHours(hours) {
  if (!Array.isArray(hours)) return [];
  return [...new Set(hours.map(Number).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b);
}

function nextFixedRunAt(hours, now = new Date()) {
  const scheduleHours = normalizeScheduleHours(hours);
  if (!scheduleHours.length) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const local = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const localNowHour = local.hour;
  const targetHour = scheduleHours.find((hour) => hour > localNowHour);
  const utcDate = new Date(Date.UTC(local.year, local.month - 1, local.day + (targetHour === undefined ? 1 : 0), (targetHour ?? scheduleHours[0]) - 7, 0));
  return utcDate;
}

function normalizeAdsRange(config = {}) {
  const startDaysAgo = Number(config.startDaysAgo ?? config.adsStartDaysAgo ?? 1);
  const endDaysAgo = Number(config.endDaysAgo ?? config.adsEndDaysAgo ?? 1);
  if (!Number.isInteger(startDaysAgo) || !Number.isInteger(endDaysAgo) || startDaysAgo < 1 || endDaysAgo < 1 || startDaysAgo > 31 || endDaysAgo > 31 || startDaysAgo < endDaysAgo) {
    throw new Error("Ads range must be whole days from D-1 to D-31, with start >= end");
  }
  return { startDaysAgo, endDaysAgo };
}

const DAILY_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_ADS_SCHEDULE_RULES = [
  { hour: 10, minute: 30, daysOfWeek: DAILY_DAYS, startDaysAgo: 1, endDaysAgo: 1 },
  { hour: 18, minute: 30, daysOfWeek: DAILY_DAYS, startDaysAgo: 1, endDaysAgo: 1 },
  { hour: 10, minute: 30, daysOfWeek: [6], startDaysAgo: 7, endDaysAgo: 2 },
];

function normalizeAdsScheduleRules(rules) {
  if (!Array.isArray(rules)) return [];
  const seen = new Set();
  return rules.map((rule) => {
    const hour = Number(rule?.hour);
    const minute = Number(rule?.minute);
    const daysOfWeek = [...new Set((rule?.daysOfWeek || []).map(Number))].sort((a, b) => a - b);
    const range = normalizeAdsRange(rule);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59 || !daysOfWeek.length || daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error("Ads schedule rule is invalid");
    }
    const normalized = { hour, minute, daysOfWeek, ...range };
    const key = JSON.stringify(normalized);
    if (seen.has(key)) throw new Error("Ads schedule rules must be unique");
    seen.add(key);
    return normalized;
  });
}

function nextScheduledRun(config, now = new Date()) {
  const rules = config.type === "IMPORT_ADS" ? normalizeAdsScheduleRules(config.adsScheduleRules) : [];
  if (!rules.length) return { at: nextFixedRunAt(config.scheduleHours, now) || nextRunAt(config.time, now), rule: null };
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const local = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  const candidates = [];
  for (let addDays = 0; addDays <= 7; addDays += 1) {
    const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day + addDays));
    const weekday = localDate.getUTCDay();
    for (const rule of rules) {
      if (!rule.daysOfWeek.includes(weekday)) continue;
      const at = new Date(Date.UTC(local.year, local.month - 1, local.day + addDays, rule.hour - 7, rule.minute));
      if (at > now) candidates.push({ at, rule });
    }
  }
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0];
}

function nextScheduledRunAt(config, now = new Date()) {
  return nextScheduledRun(config, now).at;
}

function vietnamYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftYmd(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function taskForConfig(config, now = new Date(), source = "auto_scheduler", scheduleRule = null) {
  // Upload Tracking changes the Amazon seller account and must pass manual review.
  if (config.type === "UPLOAD_TRACKING") return null;
  const typeMap = {
    IMPORT_ORDER: "IMPORT_ORDERS",
    IMPORT_FBM: "IMPORT_FBM_ORDERS",
    IMPORT_ADS: "IMPORT_ADS_SPEND",
    UPLOAD_TRACKING: "UPLOAD_TRACKING",
  };
  const type = typeMap[config.type];
  if (!type) return null;
  const payload = { autoConfigId: String(config._id), source, runKey: now.toISOString() };
  if (type === "IMPORT_ADS_SPEND") {
    const { startDaysAgo, endDaysAgo } = normalizeAdsRange(scheduleRule || config);
    const today = vietnamYmd(now);
    payload.startDate = shiftYmd(today, -startDaysAgo);
    payload.endDate = shiftYmd(today, -endDaysAgo);
    payload.date = payload.endDate; // compatible with an older extension during rollout
  }
  if (type === "UPLOAD_TRACKING") payload.autoGenerated = true;
  return { type, payload };
}

async function dispatchConfigTask(config, io, { source = "auto_scheduler", scheduleRule = null } = {}) {
  const taskSpec = taskForConfig(config, new Date(), source, scheduleRule);
  if (!taskSpec) {
    await AutoConfig.updateOne({ _id: config._id }, { $set: { lastTaskStatus: "review-required", lastTaskError: "Upload Tracking must be reviewed manually before dispatch", nextRunAt: nextScheduledRunAt(config) } });
    return { ok: false, status: "review-required", message: "Upload Tracking must be reviewed manually before dispatch" };
  }
  if (!io) throw new Error("Socket server unavailable");
  const shop = await Shop.findById(config.shopId).lean();
  const client = [...(shop?.clients || [])].sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))[0];
  if (!client?.clientId) {
    await AutoConfig.updateOne({ _id: config._id }, { $set: { lastTaskStatus: "no-client", lastTaskError: "Shop has no registered extension", nextRunAt: nextScheduledRunAt(config) } });
    return { ok: false, status: "no-client", message: "Shop has no registered extension" };
  }
  const taskId = buildTaskId({ type: taskSpec.type, shopId: config.shopId, machineId: client.clientId, payload: taskSpec.payload });
  await emitTaskToMachine(io, { taskId, type: taskSpec.type, shopId: config.shopId, machineId: client.clientId, payload: taskSpec.payload });
  await AutoConfig.updateOne({ _id: config._id }, { $set: { lastDispatchedAt: new Date(), lastTaskId: taskId, lastTaskStatus: "sent", lastTaskError: "", nextRunAt: nextScheduledRunAt(config) } });
  return { ok: true, taskId, type: taskSpec.type, machineId: client.clientId };
}

function scheduleJob(config, io) {
  const jobId = config._id.toString();

  // Dừng job cũ nếu có
  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).stop();
    activeJobs.delete(jobId);
    console.log(`🔄 [AUTO_SCHEDULER] Stopped old job for config: ${jobId}`);
  }

  console.log(`⏰ [AUTO_SCHEDULER] Scheduling job:`);
  console.log(`   configId : ${jobId}`);
  console.log(`   shopName : ${config.shopName}`);
  console.log(`   interval : every ${config.time} minute(s)`);

  let stopped = false;
  let timer = null;
  const job = { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
  const scheduleNext = (latestConfig) => {
    if (stopped || !latestConfig?.status) return;
    const next = nextScheduledRun(latestConfig);
    AutoConfig.updateOne({ _id: latestConfig._id }, { $set: { nextRunAt: next.at } }).catch(() => {});
    timer = setTimeout(async () => {
      if (stopped) return;
    console.log(`\n🔔 [AUTO_SCHEDULER] Triggered job for config: ${jobId} (${config.shopName})`);

      const current = await AutoConfig.findById(jobId);
      if (!current?.status) return;
      try {
        if (current.type !== "PULL_TRACKING") {
          await dispatchConfigTask(current, io, { scheduleRule: next.rule });
        } else {
          let syncResult = null;
          await vendorSyncBatch(
            { body: { max: 100, dryRun: false }, headers: {} },
            { json: (data) => { syncResult = data; }, status: (code) => ({ json: (data) => { syncResult = { statusCode: code, ...data }; } }) }
          );
          console.log(`✅ [AUTO_SCHEDULER] Job done: ok=${syncResult?.ok}, scanned=${syncResult?.scanned}, fail=${syncResult?.fail}`);
        }
      } catch (error) {
        console.error(`❌ [AUTO_SCHEDULER] Job failed for ${jobId}:`, error.message);
      } finally {
        scheduleNext(await AutoConfig.findById(jobId));
      }
    }, Math.max(1000, next.at.getTime() - Date.now()));
  };

  activeJobs.set(jobId, job);
  scheduleNext(config);
}

/**
 * Dừng 1 job theo configId
 */
function stopJob(configId) {
  const jobId = configId.toString();
  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).stop();
    activeJobs.delete(jobId);
    console.log(`⏹️  [AUTO_SCHEDULER] Stopped job: ${jobId}`);
  }
}

/**
 * Lấy trạng thái tất cả jobs đang chạy
 */
function getSchedulerStatus() {
  const status = [];
  activeJobs.forEach((job, id) => {
    status.push({ configId: id, running: true });
  });
  return status;
}

// Lấy tất cả
const getAll = async (req, res) => {
  try {
    const configs = await AutoConfig.find().sort({ created_at: -1 });
    res.json({ success: true, data: configs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Thêm mới
const create = async (req, res) => {
  try {
    const { type, status, time, scheduleHours, shopId, describe } = req.body || {};
    const intervalMinutes = Number(time);
    const normalizedScheduleHours = normalizeScheduleHours(scheduleHours);
    const adsRange = type === "IMPORT_ADS" ? normalizeAdsRange(req.body || {}) : {};
    const adsScheduleRules = type === "IMPORT_ADS" ? normalizeAdsScheduleRules(req.body?.adsScheduleRules) : [];
    if (!type || !shopId || (!normalizedScheduleHours.length && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1))) {
      return res.status(400).json({ success: false, message: "type, shopId and either scheduleHours or a positive legacy time are required" });
    }
    const shop = await Shop.findById(shopId).lean();
    if (!shop || shop.status !== "Active") {
      return res.status(400).json({ success: false, message: "An active shop is required" });
    }
    const existing = await AutoConfig.findOne({ shopId: String(shop._id), type }).lean();
    if (existing) {
      return res.status(409).json({ success: false, message: "This shop already has this configuration" });
    }
    const config = await AutoConfig.create({
      type,
      status: Boolean(status),
      time: Number.isInteger(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60,
      scheduleHours: normalizedScheduleHours,
      ...adsRange,
      adsScheduleRules,
      shopId: String(shop._id),
      shopName: shop.name || shop.store,
      shopType: shop.merchant || "",
      describe,
    });
    if (config.status) scheduleJob(config, req.app.get("io"));
    res.status(201).json({ success: true, data: config });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Cập nhật - tự động restart job nếu thay đổi time/status
const update = async (req, res) => {
  try {
    const updateData = { ...(req.body || {}) };
    if (Object.prototype.hasOwnProperty.call(updateData, "scheduleHours")) {
      const suppliedHours = Array.isArray(updateData.scheduleHours) ? updateData.scheduleHours : [];
      const scheduleHours = normalizeScheduleHours(suppliedHours);
      if (!scheduleHours.length || scheduleHours.length !== suppliedHours.length) {
        return res.status(400).json({ success: false, message: "scheduleHours must contain unique whole hours from 0 to 23" });
      }
      updateData.scheduleHours = scheduleHours;
    }
    if (updateData.type === "IMPORT_ADS" || Object.prototype.hasOwnProperty.call(updateData, "adsStartDaysAgo") || Object.prototype.hasOwnProperty.call(updateData, "adsEndDaysAgo")) {
      const existing = await AutoConfig.findById(req.params.id).lean();
      Object.assign(updateData, normalizeAdsRange({ ...existing, ...updateData }));
    }
    if (Object.prototype.hasOwnProperty.call(updateData, "adsScheduleRules")) {
      updateData.adsScheduleRules = normalizeAdsScheduleRules(updateData.adsScheduleRules);
    }
    const config = await AutoConfig.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    if (!config) return res.status(404).json({ success: false, message: "Not found" });

    // Sync lại scheduler
    if (config.status) {
      scheduleJob(config, req.app.get("io")); // restart với config mới
      console.log(`🔄 [AUTO_SCHEDULER] Job restarted for config: ${config._id}`);
    } else {
      stopJob(config._id); // tắt nếu status = false
      await AutoConfig.updateOne({ _id: config._id }, { $set: { nextRunAt: null } });
      console.log(`⏹️  [AUTO_SCHEDULER] Job stopped for config: ${config._id}`);
    }

    res.json({ success: true, data: config });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Xóa - dừng job nếu có
const remove = async (req, res) => {
  try {
    const config = await AutoConfig.findByIdAndDelete(req.params.id);
    if (!config) return res.status(404).json({ success: false, message: "Not found" });

    stopJob(req.params.id);

    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Manual dispatch uses the exact scheduler payload and task lifecycle.
// It intentionally excludes Upload Tracking, which has its own reviewed batch flow.
const runNow = async (req, res) => {
  try {
    const config = await AutoConfig.findById(req.params.id);
    if (!config) return res.status(404).json({ success: false, message: "Not found" });
    const result = await dispatchConfigTask(config, req.app.get("io"), { source: "manual" });
    if (!result.ok) return res.status(409).json({ success: false, ...result });
    return res.status(202).json({ success: true, data: result });
  } catch (err) {
    console.error("[AUTO_CONFIG] Manual dispatch failed:", err.message);
    return res.status(500).json({ success: false, message: "Không thể gửi task tới extension" });
  }
};

module.exports = { getAll, create, update, remove, runNow, runVendorSyncBatch, startAutoScheduler, getSchedulerStatus, nextRunAt, nextFixedRunAt, nextScheduledRun, taskForConfig, normalizeAdsRange, normalizeAdsScheduleRules, DEFAULT_ADS_SCHEDULE_RULES, vietnamYmd };

/**
 * Lấy config PULL_TRACKING đang active và tự động gọi vendor-sync/batch
 * POST /api/auto-config/run-vendor-sync
 */
async function runVendorSyncBatch(req, res) {
  const startTime = new Date();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 [AUTO_CONFIG] runVendorSyncBatch started at ${startTime.toISOString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Kiểm tra có config PULL_TRACKING đang active không
    const activeConfig = await AutoConfig.findOne({ type: "PULL_TRACKING", status: true });

    if (!activeConfig) {
      console.log(`⚠️  [AUTO_CONFIG] No active PULL_TRACKING config found - skipping`);
      return res.json({
        success: true,
        message: "No active PULL_TRACKING config found",
        processed: 0
      });
    }

    console.log(`✅ [AUTO_CONFIG] Active config found:`);
    console.log(`   _id      : ${activeConfig._id}`);
    console.log(`   shopName : ${activeConfig.shopName}`);
    console.log(`   shopId   : ${activeConfig.shopId}`);
    console.log(`   time     : ${activeConfig.time} phút`);
    console.log(`   describe : ${activeConfig.describe || 'N/A'}`);
    console.log(`🔄 [AUTO_CONFIG] Calling vendorSyncBatch...`);

    // 2. Gọi vendorSyncBatch 1 lần (không filter theo shopId)
    let syncResult = null;
    const mockReq = {
      body: { max: 100, dryRun: false },
      headers: {}
    };
    const mockRes = {
      json: (data) => { syncResult = data; },
      status: (code) => ({ json: (data) => { syncResult = { statusCode: code, ...data }; } })
    };

    await vendorSyncBatch(mockReq, mockRes);

    const endTime = new Date();
    const duration = endTime - startTime;

    if (!syncResult) {
      console.warn(`⚠️  [AUTO_CONFIG] vendorSyncBatch returned no result`);
    } else {
      console.log(`✅ [AUTO_CONFIG] vendorSyncBatch completed:`);
      console.log(`   ok             : ${syncResult?.ok}`);
      console.log(`   scanned        : ${syncResult?.scanned}`);
      console.log(`   processedOrders: ${syncResult?.processedOrders}`);
      console.log(`   success        : ${syncResult?.ok}`);
      console.log(`   fail           : ${syncResult?.fail}`);
      console.log(`   statusCode     : ${syncResult?.statusCode || 200}`);
    }

    console.log(`⏱️  [AUTO_CONFIG] Total duration: ${duration}ms`);
    console.log(`${'='.repeat(60)}\n`);

    return res.json({
      success: true,
      duration: `${duration}ms`,
      result: syncResult
    });

  } catch (err) {
    const endTime = new Date();
    const duration = endTime - startTime;
    console.error(`❌ [AUTO_CONFIG] runVendorSyncBatch fatal error after ${duration}ms`);
    console.error(`   message: ${err.message}`);
    console.error(`   stack  :`, err.stack);
    console.log(`${'='.repeat(60)}\n`);
    return res.status(500).json({ success: false, message: err.message });
  }
}
