const OrderStatusSnapshot = require("../models/orderStatusSnapshot.model");
const OrderCustomProduct = require("../models/orderCustomProduct.model");
const ShippingBatch = require("../models/shippingBatch.model");
const Shop = require("../models/shop.model");
// const { v4: uuidv4 } = require('uuid');

// Helper function để normalize field
const normalizeField = (value) => {
  if (!value || typeof value !== "string") return "";
  return value.trim();
};

class OrderStatusSyncService {
  
  /**
   * Sync order status cho một shop cụ thể
   */
  static async syncOrderStatusForShop(machineId, options = {}) {
    const startTime = Date.now();
    const snapshotId = `${machineId}_${Date.now()}_${uuidv4().slice(0, 8)}`;
    
    try {
      
      const {
        limit = 1000,
        fromDate,
        toDate,
        status = ["New", "Processing", "Shipped"],
        filterType = "all",
        syncType = "auto"
      } = options;

      // 1. Build query filter cho orders
      const orderFilter = {
        status: { $in: Array.isArray(status) ? status : [status] },
        shopId: machineId,
      };

      // Filter theo ngày tạo nếu có
      if (fromDate || toDate) {
        orderFilter.createdAt = {};
        if (fromDate) {
          const from = new Date(fromDate);
          if (!isNaN(from.getTime())) orderFilter.createdAt.$gte = from;
        }
        if (toDate) {
          const to = new Date(toDate);
          if (!isNaN(to.getTime())) orderFilter.createdAt.$lte = to;
        }
      }

      // 2. Query tất cả orders theo filter
      const allOrders = await OrderCustomProduct.find(orderFilter)
        .populate('shopId', 'name store')
        .sort({ createdAt: -1 })
        .limit(Number(limit))
        .lean();

      
      if (!allOrders.length) {
      
        return await this.saveEmptySnapshot(snapshotId, machineId, options, startTime);
      }

      // 3. Process orders (same logic as checkOrdersStatus
      const ordersWithDetails = await this.processOrdersDetails(allOrders);
       
      // 4. Check submission status
      const finalOrders = await this.checkSubmissionStatus(machineId, ordersWithDetails);
        
      // 5. Apply filter
      const filteredOrders = this.applyFilterType(finalOrders, filterType);
       
      // 6. Calculate stats
      const stats = this.calculateStats(allOrders, finalOrders, filteredOrders);
         
      // 7. Save snapshot
      const snapshot = await this.saveSnapshot({
        snapshotId,
        machineId,
        shopInfo: allOrders[0]?.shopId,
        filterConfig: { limit: Number(limit), fromDate, toDate, status, filterType },
        stats,
        orders: filteredOrders,
        syncType,
        processingTime: Date.now() - startTime
      });

      const duration = Date.now() - startTime;
     
      return snapshot;

    } catch (error) {
      const duration = Date.now() - startTime;
  
      
      // Save error snapshot
      return await this.saveErrorSnapshot(snapshotId, machineId, options, error, startTime);
    }
  }

  /**
   * Sync tất cả shops active
   */
  static async syncAllActiveShops(options = {}) {
    try {
       
      // Get all active shops
      const activeShops = await Shop.find({ 
        status: { $ne: 'inactive' } 
      }).select('_id name store').lean();
         
      if (activeShops.length === 0) {
        console.log(`⚠️ [SYNC_ALL] No active shops found to sync`);
        return {
          totalShops: 0,
          successCount: 0,
          failedCount: 0,
          results: []
        };
      }
      
      // Log shop details
     
      const results = [];
      
      // Sync từng shop (có thể chạy parallel nếu cần)
      for (const shop of activeShops) {
        try {
          
          const result = await this.syncOrderStatusForShop(shop._id.toString(), {
            ...options,
            syncType: 'auto'
          });
          results.push({ shopId: shop._id, shopName: shop.name, success: true, result });
          
        } catch (error) {
         
          results.push({ shopId: shop._id, shopName: shop.name, success: false, error: error.message });
        }
      }
      
      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;
      
      
      return {
        totalShops: activeShops.length,
        successCount,
        failedCount: activeShops.length - successCount,
        results
      };
      
    } catch (error) {
    
      throw error;
    }
  }

  // Helper methods
  static async processOrdersDetails(allOrders) {
    const ordersWithDetails = [];

    for (const order of allOrders) {
      let hasValidTracking = false;
      let tracking = "";
      let trackingInfo = null;

      // Kiểm tra tracking trong items
      for (const item of order.items || []) {
        const itemTracking = normalizeField(item?.tracking_info?.tracking);
        if (itemTracking && itemTracking !== "-" && itemTracking !== "---") {
          hasValidTracking = true;
          tracking = itemTracking;
          trackingInfo = {
            tracking: itemTracking,
            fulfillment: item.tracking_info?.fulfillment || "",
            status: item.tracking_info?.status || "",
            carrier: item.tracking_info?.note || "",
            updated_at: item.tracking_info?.updated_at || null,
          };
          break;
        }
      }

      ordersWithDetails.push({
        orderId: order.orderId,
        shopId: order.shopId?._id || order.shopId,
        shopName: order.shopId?.name || null,
        shopStore: order.shopId?.store || null,
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        hasTracking: hasValidTracking,
        tracking: tracking || null,
        trackingInfo: trackingInfo,
        itemsCount: (order.items || []).length,
        customerEmail: order.customer?.email || null,
        totalAmount: order.total_amount || 0,
      });
    }

    return ordersWithDetails;
  }

  static async checkSubmissionStatus(machineId, ordersWithDetails) {
    const allOrderIds = ordersWithDetails.map(o => o.orderId);

    const submittedBatches = await ShippingBatch.find({
      machineId,
      "completed.orderId": { $in: allOrderIds },
    }).lean();

    // Tạo Map để track submission info
    const submissionMap = new Map();
    for (const batch of submittedBatches) {
      for (const completed of batch.completed || []) {
        if (allOrderIds.includes(completed.orderId)) {
          submissionMap.set(completed.orderId, {
            batchId: batch._id,
            batchType: batch.type,
            submittedAt: batch.createdAt,
            batchLabel: batch.label,
          });
        }
      }
    }

    // Merge submission info vào orders
    return ordersWithDetails.map(order => ({
      ...order,
      submittedToAmazon: submissionMap.has(order.orderId),
      submissionInfo: submissionMap.get(order.orderId) || null,
    }));
  }

  static applyFilterType(finalOrders, filterType) {
    switch (filterType) {
      case "with-tracking":
        return finalOrders.filter(o => o.hasTracking);
      case "without-tracking":
        return finalOrders.filter(o => !o.hasTracking);
      case "submitted":
        return finalOrders.filter(o => o.submittedToAmazon);
      case "not-submitted":
        return finalOrders.filter(o => o.hasTracking && !o.submittedToAmazon);
      case "all":
      default:
        return finalOrders;
    }
  }

  static calculateStats(allOrders, finalOrders, filteredOrders) {
    return {
      totalScanned: allOrders.length,
      totalWithTracking: finalOrders.filter(o => o.hasTracking).length,
      totalWithoutTracking: finalOrders.filter(o => !o.hasTracking).length,
      totalSubmitted: finalOrders.filter(o => o.submittedToAmazon).length,
      totalNotSubmitted: finalOrders.filter(o => o.hasTracking && !o.submittedToAmazon).length,
      filteredCount: filteredOrders.length,
    };
  }

  static async saveSnapshot(data) {
    const snapshot = new OrderStatusSnapshot({
      snapshotId: data.snapshotId,
      machineId: data.machineId,
      shopId: data.shopInfo?._id || data.machineId,
      shopName: data.shopInfo?.name,
      shopStore: data.shopInfo?.store,
      filterConfig: data.filterConfig,
      stats: data.stats,
      orders: data.orders,
      syncType: data.syncType,
      processingTime: data.processingTime,
      isSuccess: true
    });

    return await snapshot.save();
  }

  static async saveEmptySnapshot(snapshotId, machineId, options, startTime) {
    const snapshot = new OrderStatusSnapshot({
      snapshotId,
      machineId,
      shopId: machineId,
      filterConfig: options,
      stats: {
        totalScanned: 0,
        totalWithTracking: 0,
        totalWithoutTracking: 0,
        totalSubmitted: 0,
        totalNotSubmitted: 0,
        filteredCount: 0,
      },
      orders: [],
      syncType: options.syncType || 'auto',
      processingTime: Date.now() - startTime,
      isSuccess: true
    });

    return await snapshot.save();
  }

  static async saveErrorSnapshot(snapshotId, machineId, options, error, startTime) {
    const snapshot = new OrderStatusSnapshot({
      snapshotId,
      machineId,
      shopId: machineId,
      filterConfig: options,
      stats: {
        totalScanned: 0,
        totalWithTracking: 0,
        totalWithoutTracking: 0,
        totalSubmitted: 0,
        totalNotSubmitted: 0,
        filteredCount: 0,
      },
      orders: [],
      syncType: options.syncType || 'auto',
      processingTime: Date.now() - startTime,
      errorMessage: error.message,
      isSuccess: false
    });

    return await snapshot.save();
  }

  /**
   * Get latest snapshot for a shop
   */
  static async getLatestSnapshot(machineId, filterType = 'all') {
    return await OrderStatusSnapshot.findOne({
      machineId,
      'filterConfig.filterType': filterType,
      isSuccess: true
    }).sort({ createdAt: -1 }).lean();
  }

  /**
   * Get snapshots history
   */
  static async getSnapshotsHistory(machineId, options = {}) {
    const { limit = 10, fromDate, toDate } = options;
    
    const filter = { machineId };
    
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = new Date(fromDate);
      if (toDate) filter.createdAt.$lte = new Date(toDate);
    }

    return await OrderStatusSnapshot.find(filter)
      .select('-orders') // Exclude orders array for performance
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();
  }
}

module.exports = OrderStatusSyncService;