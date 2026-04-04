const cron = require("node-cron");
const { shippingBatchController } = require("../controllers");
const ShippingBatch = require("../models/shippingBatch.model");

class CronJobService {
  constructor() {
    this.jobs = new Map();
  }

  /**
   * Khởi tạo tất cả cron jobs
   */
  initializeJobs() {
    // Job 1: Update fake tracking mỗi 1 tiếng
    this.scheduleUpdateFakeTracking();
    
    console.log('⏰ [CRON] All cron jobs initialized successfully');
  }

  /**
   * Schedule job update fake tracking mỗi 1 tiếng
   */
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

  /**
   * Thực thi job update fake tracking
   */
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

  /**
   * Dừng một job cụ thể
   */
  stopJob(jobName) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.stop();
      console.log(`⏹️ [CRON] Job ${jobName} stopped`);
    }
  }

  /**
   * Khởi động lại một job cụ thể
   */
  startJob(jobName) {
    const job = this.jobs.get(jobName);
    if (job) {
      job.start();
      console.log(`▶️ [CRON] Job ${jobName} started`);
    }
  }

  /**
   * Dừng tất cả jobs
   */
  stopAllJobs() {
    this.jobs.forEach((job, name) => {
      job.stop();
      console.log(`⏹️ [CRON] Job ${name} stopped`);
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
        await this.runUpdateFakeTrackingJob();
        break;
      default:
        throw new Error(`Unknown job: ${jobName}`);
    }
  }
}

module.exports = new CronJobService();