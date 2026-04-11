const mongoose = require("mongoose");

const orderStatusSnapshotSchema = new mongoose.Schema(
  {
    // Thông tin snapshot
    snapshotId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    machineId: {
      type: String,
      required: true,
      index: true
    },
    shopId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shop",
      required: true,
      index: true
    },
    shopName: String,
    shopStore: String,
    
    // Thông tin filter đã sử dụng
    filterConfig: {
      limit: Number,
      fromDate: Date,
      toDate: Date,
      status: [String],
      filterType: String
    },
    
    // Thống kê tổng quan
    stats: {
      totalScanned: Number,
      totalWithTracking: Number,
      totalWithoutTracking: Number,
      totalSubmitted: Number,
      totalNotSubmitted: Number,
      filteredCount: Number
    },
    
    // Danh sách orders (embedded document)
    orders: [{
      orderId: {
        type: String,
        required: true,
        index: true
      },
      status: String,
      createdAt: Date,
      updatedAt: Date,
      hasTracking: Boolean,
      tracking: String,
      trackingInfo: {
        tracking: String,
        fulfillment: String,
        status: String,
        carrier: String,
        updated_at: Date
      },
      itemsCount: Number,
      customerEmail: String,
      totalAmount: Number,
      submittedToAmazon: Boolean,
      submissionInfo: {
        batchId: mongoose.Schema.Types.ObjectId,
        batchType: String,
        submittedAt: Date,
        batchLabel: String
      }
    }],
    
    // Metadata
    syncType: {
      type: String,
      enum: ['manual', 'auto', 'api'],
      default: 'manual'
    },
    processingTime: Number, // milliseconds
    errorMessage: String,
    isSuccess: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true,
    collection: "orderStatusSnapshots"
  }
);

// Indexes for performance
orderStatusSnapshotSchema.index({ machineId: 1, createdAt: -1 });
orderStatusSnapshotSchema.index({ shopId: 1, createdAt: -1 });
orderStatusSnapshotSchema.index({ "orders.orderId": 1 });
orderStatusSnapshotSchema.index({ syncType: 1, createdAt: -1 });

// TTL index - tự động xóa data cũ sau 90 ngày
orderStatusSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("OrderStatusSnapshot", orderStatusSnapshotSchema);