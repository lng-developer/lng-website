const AutoJobLog = require("../models/autoJobLog.model");
const response = require("../helper/response");

/**
 * Lấy danh sách logs với phân trang và filter
 */
const getLogs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      jobId,
      jobType,
      status,
      days = 7
    } = req.query;

    // Build query
    const query = {};
    
    if (jobId) query.jobId = jobId;
    if (jobType) query.jobType = jobType;
    if (status) query.status = status;
    
    // Filter by days
    if (days) {
      const startDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
      query.startTime = { $gte: startDate };
    }

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [logs, total] = await Promise.all([
      AutoJobLog.find(query)
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      AutoJobLog.countDocuments(query)
    ]);

    // Calculate pagination info
    const totalPages = Math.ceil(total / parseInt(limit));
    const hasNext = parseInt(page) < totalPages;
    const hasPrev = parseInt(page) > 1;

    return response.success(res, {
      logs,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalItems: total,
        itemsPerPage: parseInt(limit),
        hasNext,
        hasPrev
      }
    });

  } catch (error) {
    console.error('❌ [AUTO-JOB-LOG] Get logs failed:', error.message);
    return response.error(res, error.message, 500);
  }
};

/**
 * Lấy chi tiết một log execution
 */
const getLogDetail = async (req, res) => {
  try {
    const { executionId } = req.params;

    const log = await AutoJobLog.findOne({ executionId }).lean();
    
    if (!log) {
      return response.error(res, "Log not found", 404);
    }

    return response.success(res, { log });

  } catch (error) {
    console.error('❌ [AUTO-JOB-LOG] Get log detail failed:', error.message);
    return response.error(res, error.message, 500);
  }
};

/**
 * Lấy thống kê logs
 */
const getStats = async (req, res) => {
  try {
    const { jobId, days = 7 } = req.query;

    // Get aggregated stats
    const stats = await AutoJobLog.getStats(jobId, parseInt(days));
    
    // Get recent executions
    const recentLogs = await AutoJobLog.getRecentLogs(jobId, 10);
    
    // Calculate summary
    const summary = {
      totalExecutions: 0,
      successRate: 0,
      avgDuration: 0,
      totalProcessed: 0,
      totalSuccess: 0,
      totalFailed: 0
    };

    stats.forEach(stat => {
      summary.totalExecutions += stat.count;
      if (stat._id === 'success') {
        summary.successRate = (stat.count / summary.totalExecutions) * 100;
      }
      summary.avgDuration += stat.avgDuration || 0;
      summary.totalProcessed += stat.totalProcessed || 0;
      summary.totalSuccess += stat.totalSuccess || 0;
      summary.totalFailed += stat.totalFailed || 0;
    });

    // Average duration across all statuses
    summary.avgDuration = summary.avgDuration / stats.length || 0;

    return response.success(res, {
      summary,
      breakdown: stats,
      recentExecutions: recentLogs
    });

  } catch (error) {
    console.error('❌ [AUTO-JOB-LOG] Get stats failed:', error.message);
    return response.error(res, error.message, 500);
  }
};

/**
 * Xóa logs cũ (manual cleanup)
 */
const cleanupLogs = async (req, res) => {
  try {
    const { days = 30 } = req.body;

    const cutoffDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    
    const result = await AutoJobLog.deleteMany({
      createdAt: { $lt: cutoffDate }
    });

    console.log(`🧹 [AUTO-JOB-LOG] Cleaned up ${result.deletedCount} old logs (older than ${days} days)`);

    return response.success(res, {
      message: `Cleaned up ${result.deletedCount} old logs`,
      deletedCount: result.deletedCount,
      cutoffDate
    });

  } catch (error) {
    console.error('❌ [AUTO-JOB-LOG] Cleanup failed:', error.message);
    return response.error(res, error.message, 500);
  }
};

/**
 * Lấy logs theo job ID cụ thể
 */
const getLogsByJobId = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { limit = 50 } = req.query;

    const logs = await AutoJobLog.find({ jobId })
      .sort({ startTime: -1 })
      .limit(parseInt(limit))
      .lean();

    return response.success(res, { 
      jobId,
      logs,
      count: logs.length
    });

  } catch (error) {
    console.error('❌ [AUTO-JOB-LOG] Get logs by job ID failed:', error.message);
    return response.error(res, error.message, 500);
  }
};

/**
 * Export logs (for debugging)
 */
const exportLogs = async (req, res) => {
  try {
    const { jobId, days = 1 } = req.query;

    const query = {};
    if (jobId) query.jobId = jobId;
    
    const startDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    query.startTime = { $gte: startDate };

    const logs = await AutoJobLog.find(query)
      .sort({ startTime: -1 })
      .lean();

    // Format for export
    const exportData = logs.map(log => ({
      executionId: log.executionId,
      jobId: log.jobId,
      jobType: log.jobType,
      startTime: log.startTime,
      endTime: log.endTime,
      duration: log.duration,
      status: log.status,
      result: log.result,
      error: log.error,
      stats: log.stats,
      logsCount: log.logs?.length || 0,
      detailedLogs: log.logs
    }));

    return response.success(res, {
      exportData,
      count: exportData.length,
      period: `${days} days`,
      exportedAt: new Date()
    });

  } catch (error) {
    console.error('❌ [AUTO-JOB-LOG] Export logs failed:', error.message);
    return response.error(res, error.message, 500);
  }
};

module.exports = {
  getLogs,
  getLogDetail,
  getStats,
  cleanupLogs,
  getLogsByJobId,
  exportLogs
};