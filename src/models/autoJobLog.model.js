const mongoose = require("mongoose");

const autoJobLogSchema = new mongoose.Schema(
  {
    // Thông tin job
    jobId: {
      type: String,
      required: true,
      index: true
    },
    jobType: {
      type: String,
      required: true,
      enum: ['vendorSyncBatch', 'autoRequestExtension', 'uploadTracking']
    },
    
    // Thông tin execution
    executionId: {
      type: String,
      required: true,
      index: true
    },
    startTime: {
      type: Date,
      required: true,
      index: true
    },
    endTime: {
      type: Date
    },
    duration: {
      type: Number // milliseconds
    },
    
    // Trạng thái
    status: {
      type: String,
      required: true,
      enum: ['running', 'success', 'error'],
      default: 'running'
    },
    
    // Kết quả
    result: {
      type: mongoose.Schema.Types.Mixed
    },
    error: {
      message: String,
      stack: String
    },
    
    // Logs chi tiết
    logs: [{
      timestamp: {
        type: Date,
        default: Date.now
      },
      level: {
        type: String,
        enum: ['info', 'warn', 'error', 'debug'],
        default: 'info'
      },
      message: String,
      data: mongoose.Schema.Types.Mixed
    }],
    
    // Metadata
    config: {
      type: mongoose.Schema.Types.Mixed
    },
    
    // Stats
    stats: {
      processed: Number,
      success: Number,
      failed: Number,
      details: mongoose.Schema.Types.Mixed
    }
  },
  {
    timestamps: true,
    collection: "autoJobLogs"
  }
);

// Indexes
autoJobLogSchema.index({ jobId: 1, startTime: -1 });
autoJobLogSchema.index({ jobType: 1, startTime: -1 });
autoJobLogSchema.index({ status: 1, startTime: -1 });
autoJobLogSchema.index({ createdAt: -1 });

// TTL index - tự động xóa logs sau 7 ngày
autoJobLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

// Methods
autoJobLogSchema.methods.addLog = function(level, message, data = null) {
  this.logs.push({
    timestamp: new Date(),
    level,
    message,
    data
  });
  // Không save ngay lập tức để tránh parallel save error
  // Sẽ save khi setSuccess hoặc setError
  return Promise.resolve(this);
};

autoJobLogSchema.methods.setSuccess = function(result, stats = null) {
  this.status = 'success';
  this.endTime = new Date();
  this.duration = this.endTime - this.startTime;
  this.result = result;
  if (stats) this.stats = stats;
  return this.save();
};

autoJobLogSchema.methods.setError = function(error, stats = null) {
  this.status = 'error';
  this.endTime = new Date();
  this.duration = this.endTime - this.startTime;
  this.error = {
    message: error.message,
    stack: error.stack
  };
  if (stats) this.stats = stats;
  return this.save();
};

// Static methods
autoJobLogSchema.statics.createExecution = function(jobId, jobType, config = null) {
  const executionId = `${jobId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  return this.create({
    jobId,
    jobType,
    executionId,
    startTime: new Date(),
    status: 'running',
    config,
    logs: []
  });
};

autoJobLogSchema.statics.getRecentLogs = function(jobId = null, limit = 50) {
  const query = jobId ? { jobId } : {};
  return this.find(query)
    .sort({ startTime: -1 })
    .limit(limit)
    .lean();
};

autoJobLogSchema.statics.getStats = function(jobId = null, days = 7) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const query = {
    startTime: { $gte: startDate },
    ...(jobId && { jobId })
  };
  
  return this.aggregate([
    { $match: query },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgDuration: { $avg: '$duration' },
        totalProcessed: { $sum: '$stats.processed' },
        totalSuccess: { $sum: '$stats.success' },
        totalFailed: { $sum: '$stats.failed' }
      }
    }
  ]);
};

module.exports = mongoose.model("AutoJobLog", autoJobLogSchema);