const AutoConfig = require("../models/autoConfig.model");
const { vendorSyncBatch } = require("./ext.controller");
const cron = require("node-cron");

// Map lưu các cron jobs đang chạy: configId → cron job
const activeJobs = new Map();

/**
 * Khởi động scheduler tự động theo config PULL_TRACKING
 * Gọi hàm này 1 lần khi server start
 */
async function startAutoScheduler() {
  console.log(`\n⏰ [AUTO_SCHEDULER] Initializing PULL_TRACKING scheduler...`);

  try {
    const configs = await AutoConfig.find({ type: "PULL_TRACKING", status: true });
    console.log(`📋 [AUTO_SCHEDULER] Found ${configs.length} active PULL_TRACKING config(s)`);

    for (const config of configs) {
      scheduleJob(config);
    }

    console.log(`✅ [AUTO_SCHEDULER] Scheduler initialized with ${activeJobs.size} job(s)\n`);
  } catch (err) {
    console.error(`❌ [AUTO_SCHEDULER] Failed to initialize:`, err.message);
  }
}

/**
 * Schedule 1 job theo config
 */
function scheduleJob(config) {
  const jobId = config._id.toString();

  // Dừng job cũ nếu có
  if (activeJobs.has(jobId)) {
    activeJobs.get(jobId).stop();
    activeJobs.delete(jobId);
    console.log(`🔄 [AUTO_SCHEDULER] Stopped old job for config: ${jobId}`);
  }

  // Convert time (phút) → cron pattern
  const minutes = config.time;
  const cronPattern = `*/${minutes} * * * *`;

  console.log(`⏰ [AUTO_SCHEDULER] Scheduling job:`);
  console.log(`   configId : ${jobId}`);
  console.log(`   shopName : ${config.shopName}`);
  console.log(`   interval : every ${minutes} minute(s)`);
  console.log(`   pattern  : ${cronPattern}`);

  const job = cron.schedule(cronPattern, async () => {
    console.log(`\n🔔 [AUTO_SCHEDULER] Triggered job for config: ${jobId} (${config.shopName})`);

    // Reload config mới nhất từ DB (phòng trường hợp bị tắt)
    const latestConfig = await AutoConfig.findById(jobId);
    if (!latestConfig || !latestConfig.status) {
      console.log(`⏸️  [AUTO_SCHEDULER] Config ${jobId} is disabled - skipping`);
      return;
    }

    // Gọi vendorSyncBatch
    let syncResult = null;
    const mockReq = { body: { max: 100, dryRun: false }, headers: {} };
    const mockRes = {
      json: (data) => { syncResult = data; },
      status: (code) => ({ json: (data) => { syncResult = { statusCode: code, ...data }; } })
    };

    await vendorSyncBatch(mockReq, mockRes);
    console.log(`✅ [AUTO_SCHEDULER] Job done: ok=${syncResult?.ok}, scanned=${syncResult?.scanned}, fail=${syncResult?.fail}`);

  }, { scheduled: true, timezone: "Asia/Ho_Chi_Minh" });

  activeJobs.set(jobId, job);
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
    const { type, status, time, shopId, shopName, shopType, describe } = req.body;
    const config = await AutoConfig.create({ type, status, time, shopId, shopName, shopType, describe });
    res.status(201).json({ success: true, data: config });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Cập nhật - tự động restart job nếu thay đổi time/status
const update = async (req, res) => {
  try {
    const config = await AutoConfig.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!config) return res.status(404).json({ success: false, message: "Not found" });

    // Sync lại scheduler
    if (config.type === "PULL_TRACKING") {
      if (config.status) {
        scheduleJob(config); // restart với config mới
        console.log(`🔄 [AUTO_SCHEDULER] Job restarted for config: ${config._id}`);
      } else {
        stopJob(config._id); // tắt nếu status = false
        console.log(`⏹️  [AUTO_SCHEDULER] Job stopped for config: ${config._id}`);
      }
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

module.exports = { getAll, create, update, remove, runVendorSyncBatch, startAutoScheduler, getSchedulerStatus };

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
