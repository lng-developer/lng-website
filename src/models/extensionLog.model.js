const mongoose = require("mongoose");

const extensionLogSchema = new mongoose.Schema(
  {
    // Thông tin extension
    machineId: {
      type: String,
      required: true,
      index: true
    },
    shopId: {
      type: String,
      required: true,
      index: true
    },
    shopName: {
      type: String
    },
    
    // Thông tin log
    logId: {
      type: String,
      required: true,
      index: true
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true
    },
    
    // Loại log
    logType: {
      type: String,
      required: true,
      enum: [
        'task_received',     // Extension nhận task từ server
        'task_processing',   // Đang xử lý task
        'task_completed',    // Hoàn thành task
        'task_failed',       // Task thất bại
        'upload_started',    // Bắt đầu upload
        'upload_progress',   // Tiến trình upload
        'upload_completed',  // Upload thành công
        'upload_failed',     // Upload thất bại
        'connection_status', // Trạng thái kết nối
        'error',            // Lỗi general
        'info',             // Thông tin general
        'debug'             // Debug info
      ]
    },
    
    // Level log
    level: {
      type: String,
      enum: ['debug', 'info', 'warn', 'error'],
      default: 'info'
    },
    
    // Nội dung log
    message: {
      type: String,
      required: true
    },
    
    // Task info (nếu liên quan đến task)
    taskInfo: {
      taskId: String,
      taskType: String,        // UPLOAD_TRACKING, IMPORT_ORDERS, etc.
      batchId: String,
      ordersCount: Number,
      filename: String
    },
    
    // Upload info (nếu liên quan đến upload)
    uploadInfo: {
      filename: String,
      fileSize: Number,
      progress: Number,        // 0-100
      uploadUrl: String,
      carrier: String,
      shipMethod: String,
      ordersUploaded: Number
    },
    
    // Error info (nếu có lỗi)
    errorInfo: {
      errorCode: String,
      errorMessage: String,
      stackTrace: String,
      context: mongoose.Schema.Types.Mixed
    },
    
    // Metadata
    metadata: {
      userAgent: String,
      extensionVersion: String,
      browserInfo: String,
      sessionId: String,
      requestId: String
    },
    
    // Performance info
    performance: {
      duration: Number,        // milliseconds
      memoryUsage: Number,     // MB
      cpuUsage: Number        // percentage
    },
    
    // Raw data (flexible)
    rawData: {
      type: mongoose.Schema.Types.Mixed
    }
  },
  {
    timestamps: true,
    collection: "extensionLogs"
  }
);

// Indexes for efficient queries
extensionLogSchema.index({ machineId: 1, timestamp: -1 });
extensionLogSchema.index({ shopId: 1, timestamp: -1 });
extensionLogSchema.index({ logType: 1, timestamp: -1 });
extensionLogSchema.index({ level: 1, timestamp: -1 });
extensionLogSchema.index({ 'taskInfo.taskType': 1, timestamp: -1 });
extensionLogSchema.index({ 'taskInfo.batchId': 1 });

// TTL index - tự động xóa logs sau 30 ngày
extensionLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Static methods
extensionLogSchema.statics.createLog = function(logData) {
  const logId = `${logData.machineId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  return this.create({
    ...logData,
    logId,
    timestamp: new Date()
  });
};

extensionLogSchema.statics.getRecentLogs = function(machineId, limit = 50) {
  const query = machineId ? { machineId } : {};
  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

extensionLogSchema.statics.getLogsByTask = function(taskId, batchId) {
  const query = {};
  if (taskId) query['taskInfo.taskId'] = taskId;
  if (batchId) query['taskInfo.batchId'] = batchId;
  
  return this.find(query)
    .sort({ timestamp: -1 })
    .lean();
};

extensionLogSchema.statics.getLogStats = function(machineId, hours = 24) {
  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const query = {
    timestamp: { $gte: startTime },
    ...(machineId && { machineId })
  };
  
  return this.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$logType',
        count: { $sum: 1 },
        lastLog: { $max: '$timestamp' }
      }
    },
    { $sort: { count: -1 } }
  ]);
};

module.exports = mongoose.model("ExtensionLog", extensionLogSchema);