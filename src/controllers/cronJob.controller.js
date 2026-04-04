const cronJobService = require("../service/cronJobs");

/**
 * Lấy trạng thái của tất cả cron jobs
 */
const getJobsStatus = async (req, res) => {
  try {
    const status = cronJobService.getJobsStatus();
    return res.json({
      ok: true,
      jobs: status
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
};

/**
 * Chạy job thủ công
 */
const runJobManually = async (req, res) => {
  try {
    const { jobName } = req.params;
    
    if (!jobName) {
      return res.status(400).json({
        ok: false,
        message: "jobName is required"
      });
    }

    await cronJobService.runJobManually(jobName);
    
    return res.json({
      ok: true,
      message: `Job ${jobName} executed successfully`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
};

/**
 * Dừng một job
 */
const stopJob = async (req, res) => {
  try {
    const { jobName } = req.params;
    
    if (!jobName) {
      return res.status(400).json({
        ok: false,
        message: "jobName is required"
      });
    }

    cronJobService.stopJob(jobName);
    
    return res.json({
      ok: true,
      message: `Job ${jobName} stopped successfully`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
};

/**
 * Khởi động một job
 */
const startJob = async (req, res) => {
  try {
    const { jobName } = req.params;
    
    if (!jobName) {
      return res.status(400).json({
        ok: false,
        message: "jobName is required"
      });
    }

    cronJobService.startJob(jobName);
    
    return res.json({
      ok: true,
      message: `Job ${jobName} started successfully`
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message
    });
  }
};

module.exports = {
  getJobsStatus,
  runJobManually,
  stopJob,
  startJob
};