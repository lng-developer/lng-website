const cron = require("node-cron");
const { shippingBatchController } = require("../controllers");
const ShippingBatch = require("../models/shippingBatch.model");
const OrderStatusSyncService = require("./orderStatusSync");
const SnapshotAutoSyncService = require("./snapshotAutoSync");

class CronJobService {
  constructor() {
    this.jobs = new Map();
    this.autoJobs = new Map(); // Map để lưu các auto jobs từ ConfigAuto
    this.io = null; // Lưu Socket.IO instance
  }

  /**
   * Set Socket.IO instance để sử dụng trong auto jobs
   */
  setSocketIO(io) {
    this.io = io;
  }

  /**
   * Khởi tạo tất cả cron jobs
   */
  async initializeJobs() {
    // Job 1: Update fake tracking mỗi 1 tiếng (COMMENTED OUT - removed fake tracking)
    // this.scheduleUpdateFakeTracking();
    
    // Job 2: Load và khởi tạo các auto jobs từ ConfigAuto
    await this.loadAutoJobsFromDatabase();
    
    // Job 3: Order Status Sync - chạy mỗi giờ
    this.scheduleOrderStatusSync();
    
    // Job 4: Snapshot Auto Sync - chạy mỗi 15 phút
    this.scheduleSnapshotAutoSync();
    
    console.log('⏰ [CRON] All cron jobs initialized successfully');
  }

  /**
   * Schedule auto upload jobs - only uploads orders with real tracking
   */
  scheduleAutoUploadJobs() {
    if (!this.autoUploadConfig.enabled) {
      return;
    }

    // Regular auto upload (every 30 minutes)
    if (this.autoUploadConfig.jobs.regular.enabled) {
      this.scheduleAutoUploadJob('regular', this.autoUploadConfig.jobs.regular.cronPattern);
    }

    // Morning auto upload (8 AM daily)
    if (this.autoUploadConfig.jobs.morning.enabled) {
      this.scheduleAutoUploadJob('morning', this.autoUploadConfig.jobs.morning.cronPattern);
    }

    // Afternoon auto upload (2 PM daily)
    if (this.autoUploadConfig.jobs.afternoon.enabled) {
      this.scheduleAutoUploadJob('afternoon', this.autoUploadConfig.jobs.afternoon.cronPattern);
    }
  }

  /**
   * Schedule a specific auto upload job
   */
  scheduleAutoUploadJob(jobType, cronPattern) {
    const jobName = `autoUpload_${jobType}`;
    
    const job = cron.schedule(cronPattern, async () => {
      await this.runAutoUploadJob(jobType);
    }, {
      scheduled: false,
      timezone: "Asia/Ho_Chi_Minh"
    });

    this.jobs.set(jobName, job);
    job.start();
    
  }

  /**
   * Execute auto upload job - only processes orders with real tracking
   */
  async runAutoUploadJob(jobType) {
    const startTime = new Date();
    
    try {
      // Find uploadable batches with real tracking only
      const uploadableBatches = await ShippingBatch.find({
        type: 'CONFIRM',
        status: 'CONFIRM_FILE_READY',
        uploadTaskSent: { $ne: true },
        'completed.0': { $exists: true }, // Has at least one completed item
        $or: [
          { 'completed.isFake': { $ne: true } }, // Not fake
          { 'completed.isFake': { $exists: false } }, // isFake field doesn't exist
          { 'completed.source': { $ne: 'fake' } } // Source is not fake
        ]
      }).limit(10); // Limit to prevent overload


      
      if (uploadableBatches.length === 0) {
        return;
      }

      // Extract batch IDs
      const batchIds = uploadableBatches.map(batch => batch._id.toString());
      
      // Call the auto upload function
      const result = await shippingBatchController.autoUploadTask(batchIds);
      
      const endTime = new Date();
      const duration = endTime - startTime;
      
      
    } catch (error) {
    }
  }
  /**
   * Schedule job update fake tracking mỗi 1 tiếng (COMMENTED OUT - removed fake tracking)
   */
  /*
  scheduleUpdateFakeTracking() {
    const jobName = 'updateFakeTracking';
    
    // Chạy vào phút 0 của mỗi giờ (0 * * * *)
    const job = cron.schedule('0 * * * *', async () => {
      await this.runUpdateFakeTrackingJob();
    }, {
      scheduled: false, // Không tự động start
      timezone: "Asia/Ho_Chi_Minh"
    });

    this.jobs.set(jobName, job);
    job.start();
    
    console.log(`⏰ [CRON] ${jobName} scheduled to run every hour`);
  }
  */

  /**
   * Thực thi job update fake tracking (COMMENTED OUT - removed fake tracking)
   */
  /*
  async runUpdateFakeTrackingJob() {
    const startTime = new Date();
    console.log(`🔄 [CRON][${startTime.toISOString()}] Starting updateAllFakeTracking job...`);
    
    try {
      // Lấy danh sách các machineId có fake tracking
      const uniqueMachineIds = await ShippingBatch.distinct('machineId', {
        type: 'CONFIRM',
        tracking_fakes: { $exists: true, $ne: [] }
      });
      
      console.log(`📋 [CRON] Found ${uniqueMachineIds.length} machineIds with fake tracking:`, uniqueMachineIds);
      
      if (uniqueMachineIds.length === 0) {
        console.log('✅ [CRON] No fake tracking found, job completed');
        return;
      }

      let successCount = 0;
      let errorCount = 0;

      for (const machineId of uniqueMachineIds) {
        try {
          console.log(`🔄 [CRON] Processing machineId: ${machineId}`);
          
          // Tạo mock req/res objects
          const mockReq = { body: { machineId } };
          const mockRes = {
            status: (code) => ({
              json: (data) => {
                if (code >= 400) {
                  console.log(`⚠️ [CRON][${machineId}] Status ${code}:`, data);
                } else {
                  console.log(`✅ [CRON][${machineId}] Status ${code}:`, data);
                }
                return mockRes;
              }
            }),
            json: (data) => {
              console.log(`✅ [CRON][${machineId}] Success:`, data);
              return mockRes;
            }
          };
          const mockNext = (err) => {
            console.error(`❌ [CRON][${machineId}] Error:`, err.message);
            throw err;
          };
          
          await shippingBatchController.updateAllFakeTracking(mockReq, mockRes, mockNext);
          successCount++;
          
        } catch (error) {
          console.error(`❌ [CRON][${machineId}] Failed:`, error.message);
          errorCount++;
        }
      }
      
      const endTime = new Date();
      const duration = endTime - startTime;
      
      console.log(`✅ [CRON][${endTime.toISOString()}] updateAllFakeTracking job completed`);
      console.log(`📊 [CRON] Summary: ${successCount} success, ${errorCount} errors, duration: ${duration}ms`);
      
    } catch (error) {
      console.error('❌ [CRON] updateAllFakeTracking job failed:', error.message);
    }
  }
  */

  /**
   * Load các auto jobs từ database và khởi tạo cron jobs
   */
  async loadAutoJobsFromDatabase() {
    try {
      const ConfigAuto = require("../models/configAuto.model");
      const activeConfigs = await ConfigAuto.find({ status: true }); // status: true thay vì "active"
      
   
      
      for (const config of activeConfigs) {
        await this.addAutoJob(config);
      }
      
 
    } catch (error) {
 
    }
  }

  /**
   * Thêm một auto job mới
   */
  async addAutoJob(config) {
    try {
      const jobName = `auto_${config.id}`;
      
      // Nếu job đã tồn tại, xóa trước
      if (this.autoJobs.has(jobName)) {
        await this.removeAutoJob(config.id);
      }
      
      const job = cron.schedule(config.autoTime, async () => {
        await this.executeAutoJob(config);
      }, {
        scheduled: false,
        timezone: "Asia/Ho_Chi_Minh"
      });

      this.autoJobs.set(jobName, {
        job,
        config: config.toObject ? config.toObject() : config
      });
      
      job.start();
      

      
    } catch (error) {

      throw error;
    }
  }

  /**
   * Xóa một auto job
   */
  async removeAutoJob(configId) {
    try {
      const jobName = `auto_${configId}`;
      const jobData = this.autoJobs.get(jobName);
      
      if (jobData) {
        jobData.job.stop();
        this.autoJobs.delete(jobName);

      }
      
    } catch (error) {

    }
  }

  /**
   * Thực thi một auto job
   */
  async executeAutoJob(config) {
    const AutoJobLog = require("../models/autoJobLog.model");
    let jobLog = null;
    
    try {
      // Tạo log entry
      jobLog = await AutoJobLog.createExecution(config.id, config.type, config.config);
      await jobLog.addLog('info', `Starting auto job: ${config.id} (${config.type})`);
      
       
      // Cập nhật trạng thái đang chạy
      await this.updateConfigStats(config.id, {
        lastRunAt: jobLog.startTime,
        lastRunStatus: "running"
      });

      let result;
      
      switch (config.type) {
        case "vendorSyncBatch":
          result = await this.executeVendorSyncBatch(config, jobLog);
          break;
        case "autoRequestExtension":
          result = await this.executeAutoRequestExtension(config, jobLog);
          break;
        case "uploadTracking":
          result = await this.executeUploadTracking(config, jobLog);
          break;
        default:
          throw new Error(`Unknown auto job type: ${config.type}`);
      }

      // Log thành công
      const stats = {
        processed: result?.processed || result?.processedOrders || 0,
        success: result?.success || result?.ok || 0,
        failed: result?.failed || result?.fail || 0,
        details: result
      };
      
      await jobLog.setSuccess(result, stats);
      await jobLog.addLog('info', `Job completed successfully`, { result, stats });

      // Cập nhật thống kê thành công
      await this.updateConfigStats(config.id, {
        lastRunAt: jobLog.endTime,
        lastRunStatus: "success",
        lastRunResult: result,
        $inc: { "stats.totalRuns": 1 }
      });
    
      return result;
      
    } catch (error) {
      // Log lỗi
      if (jobLog) {
        await jobLog.setError(error);
        await jobLog.addLog('error', `Job failed: ${error.message}`, { 
          error: error.message, 
          stack: error.stack 
        });
      }

      // Cập nhật thống kê lỗi
      await this.updateConfigStats(config.id, {
        lastRunAt: new Date(),
        lastRunStatus: "error",
        lastRunResult: { error: error.message },
        $inc: { "stats.totalRuns": 1 }
      });

      console.error(`❌ [CRON] Auto job '${config.id}' failed:`, error.message);
      throw error;
    }
  }

  /**
   * Thực thi autoRequestExtension job
   */
  async executeAutoRequestExtension(config, jobLog = null) {
    if (jobLog) {
      await jobLog.addLog('info', `Executing autoRequestExtension job`, { configId: config.id });
    }
    
     
    const { extController } = require("../controllers");
    
    // Tạo mock req/res objects với Socket.IO thực tế
    const mockReq = {
      body: {
        type: config.config?.taskType || 'IMPORT_ORDERS',
        payload: config.config?.payload || null,
        action: 'auto',
        label: 'Auto Request Extension'
      },
      headers: {}, // Không có user-agent để đánh dấu là auto call
      app: {
        get: (key) => {
          if (key === 'io') {
            // Không log ở đây để tránh parallel save
            return this.io; // Trả về Socket.IO instance thực tế
          }
          return null;
        }
      }
    };
    
    let result = null;
    const mockRes = {
      status: (code) => ({
        json: (data) => {
          result = { statusCode: code, ...data };
          return mockRes;
        }
      }),
      json: (data) => {
        result = { statusCode: 200, ...data };
        return mockRes;
      }
    };
    
    const mockNext = (err) => {
      throw err;
    };
    
    if (jobLog) {
      await jobLog.addLog('info', `Calling autoRequestExtensionAll function`);
    }
    
    // Gọi hàm autoRequestExtensionAll thực tế
    await extController.autoRequestExtensionAll(mockReq, mockRes, mockNext);
    
    if (jobLog) {
      await jobLog.addLog('info', `autoRequestExtension completed`, { 
        statusCode: result?.statusCode,
        processed: result?.processed,
        success: result?.success,
        failed: result?.failed
      });
    }
    

    return result;
  }

  /**
   * Thực thi vendorSyncBatch job
   */
  async executeVendorSyncBatch(config, jobLog = null) {
    if (jobLog) {
      await jobLog.addLog('info', `Executing vendorSyncBatch job`, { configId: config.id });
    }
    

    
    const { extController } = require("../controllers");
    
    // Tạo mock req/res objects giống như API call
    const mockReq = {
      body: {
        max: config.config?.maxOrders || 100,
        dryRun: config.config?.dryRun || false
      },
      headers: {} // Không có user-agent để đánh dấu là auto call
    };
    
    let result = null;
    const mockRes = {
      status: (code) => ({
        json: (data) => {
          result = { statusCode: code, ...data };
          return mockRes;
        }
      }),
      json: (data) => {
        result = { statusCode: 200, ...data };
        return mockRes;
      }
    };
    
    const mockNext = (err) => {
      throw err;
    };
    
    if (jobLog) {
      await jobLog.addLog('info', `Calling vendorSyncBatch function`);
    }
    
    // Gọi hàm vendorSyncBatch thực tế
    await extController.vendorSyncBatch(mockReq, mockRes, mockNext);
    
    if (jobLog) {
      await jobLog.addLog('info', `vendorSyncBatch completed`, { 
        statusCode: result?.statusCode,
        processedOrders: result?.processedOrders,
        scanned: result?.scanned,
        success: result?.ok,
        failed: result?.fail
      });
    }
    

    
    return result;
  }

  /**
   * Thực thi uploadTracking job - sử dụng AutoUploadTrackingService mới
   */
  async executeUploadTracking(config, jobLog = null) {
    if (jobLog) {
      await jobLog.addLog('info', `Executing uploadTracking job`, { configId: config.id });
    }
    

    
    // Import AutoUploadTrackingService
    const AutoUploadTrackingService = require("./autoUploadTrackingService");
    
    if (jobLog) {
      await jobLog.addLog('info', `Calling AutoUploadTrackingService.autoUploadTrackingForAllShops`);
    }
    
    // Gọi service trực tiếp với Socket.IO instance
    const result = await AutoUploadTrackingService.autoUploadTrackingForAllShops(this.io, {
      maxOrdersPerShop: config.config?.maxOrdersPerShop || 50,
      onlyWithTracking: config.config?.onlyWithTracking !== false,
      onlyNotSubmitted: config.config?.onlyNotSubmitted !== false,
      excludeShops: config.config?.excludeShops || [],
      includeShops: config.config?.includeShops || [],
      carrierCode: config.config?.carrierCode || "USPS",
      shipMethod: config.config?.shipMethod || "USPS First Class",
      dryRun: config.config?.dryRun || false
    });
    
    if (jobLog) {
      await jobLog.addLog('info', `uploadTracking completed`, { 
        success: result?.success,
        totalShops: result?.totalShops,
        successfulShops: result?.successfulShops,
        failedShops: result?.failedShops,
        totalOrders: result?.totalOrders
      });
    }
    

    
    // Format result để match với expected format
    return {
      ok: result?.success,
      statusCode: result?.success ? 200 : 500,
      processed: result?.totalOrders || 0,
      success: result?.successfulShops || 0,
      failed: result?.failedShops || 0,
      totalShops: result?.totalShops || 0,
      message: result?.message || 'Upload tracking completed',
      results: result?.results || []
    };
  }

  /**
   * Cập nhật thống kê config
   */
  async updateConfigStats(configId, updateData) {
    try {
      const ConfigAuto = require("../models/configAuto.model");
      await ConfigAuto.updateOne({ id: configId }, updateData);
    } catch (error) {
      
    }
  }

  /**
   * Chạy auto job thủ công
   */
  async runAutoJobManually(config) {
   
    await this.executeAutoJob(config);
    return { message: `Auto job '${config.id}' executed manually` };
  }

  /**
   * Lấy trạng thái tất cả jobs (bao gồm auto jobs)
   */
  getJobsStatus() {
    const status = {};
    
    // Regular jobs
    this.jobs.forEach((job, name) => {
      status[name] = {
        type: "regular",
        running: job.running,
        scheduled: job.scheduled
      };
    });
    
    // Auto jobs
    this.autoJobs.forEach((jobData, name) => {
      status[name] = {
        type: "auto",
        configType: jobData.config.type,
        running: jobData.job.running,
        scheduled: jobData.job.scheduled,
        cronPattern: jobData.config.autoTime
      };
    });
    
    return status;
  }

  /**
   * Update auto upload configuration
   */
  updateAutoUploadConfig(newConfig) {
    this.autoUploadConfig = { ...this.autoUploadConfig, ...newConfig };
  }

  /**
   * Get current auto upload configuration
   */
  getAutoUploadConfig() {
    return this.autoUploadConfig;
  }

  /**
   * Restart auto upload jobs with new configuration
   */
  restartAutoUploadJobs() {
    // Stop existing auto upload jobs
    ['autoUpload_regular', 'autoUpload_morning', 'autoUpload_afternoon'].forEach(jobName => {
      this.stopJob(jobName);
      this.jobs.delete(jobName);
    });

    // Restart with new config
    this.scheduleAutoUploadJobs();
  }

  /**
   * Dừng một job cụ thể
   */
  stopJob(jobName) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.stop();
    }
  }

  /**
   * Khởi động lại một job cụ thể
   */
  startJob(jobName) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.start();
    }
  }

  /**
   * Dừng tất cả jobs
   */
  stopAllJobs() {
    this.jobs.forEach((job, name) => {
      job.stop();
    });
  }

  /**
   * Lấy trạng thái của tất cả jobs
   */
  getJobsStatus() {
    const status = {};
    this.jobs.forEach((job, name) => {
      status[name] = {
        running: job.running,
        scheduled: job.scheduled
      };
    });
    return status;
  }

  /**
   * Chạy job thủ công (để test)
   */
  async runJobManually(jobName) {
    switch (jobName) {
      case 'updateFakeTracking':
        // await this.runUpdateFakeTrackingJob(); // COMMENTED OUT
        break;
      case 'autoUpload_regular':
        await this.runAutoUploadJob('regular');
        break;
      case 'autoUpload_morning':
        await this.runAutoUploadJob('morning');
        break;
      case 'autoUpload_afternoon':
        await this.runAutoUploadJob('afternoon');
        break;
      case 'orderStatusSync':
        await this.runOrderStatusSyncJob();
        break;
      default:
        throw new Error(`Unknown job: ${jobName}`);
    }
  }

  /**
   * Schedule Order Status Sync Job - chạy mỗi 15 phút
   */
  scheduleOrderStatusSync() {
    const jobName = 'orderStatusSync';
    
    // Chạy mỗi 15 phút (thay vì 5 phút để tránh ghi đè auto upload test)
    const cronPattern = '*/15 * * * *';
    
    const job = cron.schedule(cronPattern, async () => {
      await this.runOrderStatusSyncJob();
    }, {
      scheduled: false,
      timezone: "Asia/Ho_Chi_Minh"
    });

    this.jobs.set(jobName, job);
    job.start();
    
  }

  /**
   * Chạy Order Status Sync Job
   */
  async runOrderStatusSyncJob() {
    try {
      const timestamp = new Date().toISOString();
      const startTime = Date.now();
      
      // Sync tất cả shops active
      const result = await OrderStatusSyncService.syncAllActiveShops({
        limit: 1000,
        status: ["New", "Processing", "Shipped"],
        filterType: "all"
      });
      
      const duration = Date.now() - startTime;
      
  
      // Emit socket event nếu có
      if (this.io) {
        this.io.emit('orderStatusSyncCompleted', {
          timestamp: new Date(),
          duration,
          result,
          nextRun: new Date(Date.now() + 15*60*1000) // Next run in 15 minutes
        });
      
      }
      
      return result;
      
    } catch (error) {
      const timestamp = new Date().toISOString();
    
      
      // Emit error event
      if (this.io) {
        this.io.emit('orderStatusSyncError', {
          timestamp: new Date(),
          error: error.message,
          nextRetry: new Date(Date.now() + 15*60*1000)
        });
      }
      
      throw error;
    }
  }

  /**
   * Schedule Snapshot Auto Sync Job - chạy mỗi 15 phút
   */
  scheduleSnapshotAutoSync() {
    const jobName = 'snapshotAutoSync';
    
    // Chạy mỗi 15 phút
    const cronPattern = '*/15 * * * *';
    
    const job = cron.schedule(cronPattern, async () => {
      await this.runSnapshotAutoSyncJob();
    }, {
      scheduled: false,
      timezone: "Asia/Ho_Chi_Minh"
    });

    this.jobs.set(jobName, job);
    job.start();
    
  }

  /**
   * Chạy Snapshot Auto Sync Job
   */
  async runSnapshotAutoSyncJob() {
    try {
      const timestamp = new Date().toISOString();
      
      const startTime = Date.now();
      
      // Sync tất cả shops có snapshots
      const result = await SnapshotAutoSyncService.scheduledSyncAllShops();
      
      const duration = Date.now() - startTime;
      
      // Emit socket event nếu có
      if (this.io) {
        this.io.emit('snapshotAutoSyncCompleted', {
          timestamp: new Date(),
          duration,
          result,
          nextRun: new Date(Date.now() + 15*60*1000)
        });
      }
      
      return result;
      
    } catch (error) {
      const timestamp = new Date().toISOString();
      // Emit error event
      if (this.io) {
        this.io.emit('snapshotAutoSyncError', {
          timestamp: new Date(),
          error: error.message,
          nextRetry: new Date(Date.now() + 15*60*1000)
        });
      }
      
      throw error;
    }
  }
}

module.exports = new CronJobService();