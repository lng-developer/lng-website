const ExtensionLog = require("../models/extensionLog.model");
const response = require("../helper/response");

/**
 * API cho extensions gửi logs lên server
 * POST /api/ext/logs
 */
const submitLog = async (req, res) => {
  try {
    const {
      machineId,
      shopId,
      shopName,
      logType,
      level = 'info',
      message,
      taskInfo,
      uploadInfo,
      errorInfo,
      metadata,
      performance,
      rawData
    } = req.body;

    // Validation
    if (!machineId || !shopId || !logType || !message) {
      return response.fail(res, 400, "Missing required fields: machineId, shopId, logType, message");
    }

    // Tạo log entry
    const logEntry = await ExtensionLog.createLog({
      machineId,
      shopId,
      shopName,
      logType,
      level,
      message,
      taskInfo,
      uploadInfo,
      errorInfo,
      metadata: {
        ...metadata,
        userAgent: req.headers['user-agent'],
        sessionId: req.headers['x-session-id'],
        requestId: req.headers['x-request-id']
      },
      performance,
      rawData
    });

    console.log(`📝 [EXT-LOG] ${machineId} (${shopName}): ${logType} - ${message}`);

    return response.success(res, {
      logId: logEntry.logId,
      timestamp: logEntry.timestamp,
      message: "Log submitted successfully"
    });

  } catch (error) {
    console.error('❌ [EXT-LOG] Submit log failed:', error.message);
    return response.fail(res, 500, error.message);
  }
};

/**
 * API để lấy logs của extension cụ thể
 * GET /api/ext/logs/:machineId
 */
const getLogs = async (req, res) => {
  try {
    const { machineId } = req.params;
    const {
      limit = 50,
      logType,
      level,
      hours = 24,
      taskType,
      batchId
    } = req.query;

    // Build query
    const startTime = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const query = {
      machineId,
      timestamp: { $gte: startTime }
    };

    if (logType) query.logType = logType;
    if (level) query.level = level;
    if (taskType) query['taskInfo.taskType'] = taskType;
    if (batchId) query['taskInfo.batchId'] = batchId;

    // Execute query
    const logs = await ExtensionLog.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();

    // Get stats
    const stats = await ExtensionLog.getLogStats(machineId, parseInt(hours));

    return response.success(res, {
      machineId,
      logs,
      stats,
      totalCount: logs.length,
      timeRange: `${hours} hours`,
      query: {
        logType,
        level,
        taskType,
        batchId,
        limit: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('❌ [EXT-LOG] Get logs failed:', error.message);
    return response.fail(res, 500, error.message);
  }
};

/**
 * API để lấy logs theo task/batch
 * GET /api/ext/logs/task/:taskId hoặc /api/ext/logs/batch/:batchId
 */
const getLogsByTask = async (req, res) => {
  try {
    const { taskId, batchId } = req.params;

    if (!taskId && !batchId) {
      return response.fail(res, 400, "Either taskId or batchId is required");
    }

    const logs = await ExtensionLog.getLogsByTask(taskId, batchId);

    return response.success(res, {
      taskId,
      batchId,
      logs,
      totalCount: logs.length
    });

  } catch (error) {
    console.error('❌ [EXT-LOG] Get logs by task failed:', error.message);
    return response.fail(res, 500, error.message);
  }
};

/**
 * API để lấy thống kê logs
 * GET /api/ext/logs/stats/:machineId
 */
const getLogStats = async (req, res) => {
  try {
    const { machineId } = req.params;
    const { hours = 24 } = req.query;

    // Get basic stats
    const stats = await ExtensionLog.getLogStats(machineId, parseInt(hours));

    // Get recent activity
    const recentLogs = await ExtensionLog.getRecentLogs(machineId, 10);

    // Get error count
    const startTime = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const errorCount = await ExtensionLog.countDocuments({
      machineId,
      level: 'error',
      timestamp: { $gte: startTime }
    });

    // Get task completion rate
    const taskStats = await ExtensionLog.aggregate([
      {
        $match: {
          machineId,
          timestamp: { $gte: startTime },
          logType: { $in: ['task_completed', 'task_failed'] }
        }
      },
      {
        $group: {
          _id: '$logType',
          count: { $sum: 1 }
        }
      }
    ]);

    const completed = taskStats.find(s => s._id === 'task_completed')?.count || 0;
    const failed = taskStats.find(s => s._id === 'task_failed')?.count || 0;
    const total = completed + failed;
    const successRate = total > 0 ? (completed / total * 100).toFixed(2) : 0;

    return response.success(res, {
      machineId,
      timeRange: `${hours} hours`,
      summary: {
        totalLogs: stats.reduce((sum, s) => sum + s.count, 0),
        errorCount,
        taskSuccessRate: `${successRate}%`,
        tasksCompleted: completed,
        tasksFailed: failed
      },
      logTypeBreakdown: stats,
      recentActivity: recentLogs.slice(0, 5).map(log => ({
        timestamp: log.timestamp,
        logType: log.logType,
        level: log.level,
        message: log.message
      }))
    });

  } catch (error) {
    console.error('❌ [EXT-LOG] Get stats failed:', error.message);
    return response.fail(res, 500, error.message);
  }
};

/**
 * API để lấy logs của tất cả extensions (admin)
 * GET /api/ext/logs/all
 */
const getAllLogs = async (req, res) => {
  try {
    const {
      limit = 100,
      logType,
      level,
      hours = 24,
      shopId
    } = req.query;

    // Build query
    const startTime = new Date(Date.now() - parseInt(hours) * 60 * 60 * 1000);
    const query = {
      timestamp: { $gte: startTime }
    };

    if (logType) query.logType = logType;
    if (level) query.level = level;
    if (shopId) query.shopId = shopId;

    // Execute query
    const logs = await ExtensionLog.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();

    // Get active extensions
    const activeExtensions = await ExtensionLog.aggregate([
      {
        $match: {
          timestamp: { $gte: new Date(Date.now() - 60 * 60 * 1000) } // Last hour
        }
      },
      {
        $group: {
          _id: '$machineId',
          shopId: { $first: '$shopId' },
          shopName: { $first: '$shopName' },
          lastActivity: { $max: '$timestamp' },
          logCount: { $sum: 1 }
        }
      },
      { $sort: { lastActivity: -1 } }
    ]);

    return response.success(res, {
      logs,
      activeExtensions,
      totalCount: logs.length,
      timeRange: `${hours} hours`,
      query: {
        logType,
        level,
        shopId,
        limit: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('❌ [EXT-LOG] Get all logs failed:', error.message);
    return response.fail(res, 500, error.message);
  }
};

/**
 * API để xóa logs cũ (cleanup)
 * DELETE /api/ext/logs/cleanup
 */
const cleanupLogs = async (req, res) => {
  try {
    const { days = 30, machineId } = req.body;

    const cutoffDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);
    const query = {
      createdAt: { $lt: cutoffDate }
    };

    if (machineId) query.machineId = machineId;

    const result = await ExtensionLog.deleteMany(query);

    console.log(`🧹 [EXT-LOG] Cleaned up ${result.deletedCount} extension logs (older than ${days} days)`);

    return response.success(res, {
      message: `Cleaned up ${result.deletedCount} extension logs`,
      deletedCount: result.deletedCount,
      cutoffDate,
      machineId: machineId || 'all'
    });

  } catch (error) {
    console.error('❌ [EXT-LOG] Cleanup failed:', error.message);
    return response.fail(res, 500, error.message);
  }
};

module.exports = {
  submitLog,
  getLogs,
  getLogsByTask,
  getLogStats,
  getAllLogs,
  cleanupLogs
};