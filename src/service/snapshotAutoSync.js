const OrderStatusSnapshot = require("../models/orderStatusSnapshot.model");
const ShippingBatch = require("../models/shippingBatch.model");

class SnapshotAutoSyncService {
  
  /**
   * Tự động cập nhật trạng thái submittedToAmazon cho một order cụ thể
   */
  static async updateOrderSubmissionStatus(orderId, machineId, submissionInfo = null) {
    try {
       
      // Tìm tất cả snapshots chứa order này
      const snapshots = await OrderStatusSnapshot.find({
        machineId,
        "orders.orderId": orderId,
        isSuccess: true
      });
      
      if (snapshots.length === 0) {
              return { updated: 0, snapshots: [] };
      }
      
      
      const updateResults = [];
      
      for (const snapshot of snapshots) {
        try {
          // Tìm order trong snapshot
          const orderIndex = snapshot.orders.findIndex(o => o.orderId === orderId);
          
          if (orderIndex === -1) {
                  continue;
          }
          
          // Xác định trạng thái submission mới
          const isSubmitted = submissionInfo !== null;
          const currentStatus = snapshot.orders[orderIndex].submittedToAmazon;
          
          // Chỉ update nếu có thay đổi
          if (currentStatus !== isSubmitted) {
            // Update order trong snapshot
            snapshot.orders[orderIndex].submittedToAmazon = isSubmitted;
            snapshot.orders[orderIndex].submissionInfo = submissionInfo;
            
            // Recalculate stats
            const newStats = this.recalculateStats(snapshot.orders);
            snapshot.stats = newStats;
            
            // Save snapshot
            await snapshot.save();
            
                updateResults.push({
              snapshotId: snapshot.snapshotId,
              orderId,
              oldStatus: currentStatus,
              newStatus: isSubmitted,
              updated: true
            });
          } else {
                 updateResults.push({
              snapshotId: snapshot.snapshotId,
              orderId,
              status: isSubmitted,
              updated: false
            });
          }
          
        } catch (error) {
          console.error(`❌ [AUTO_SYNC] Error updating snapshot ${snapshot.snapshotId}:`, error);
          updateResults.push({
            snapshotId: snapshot.snapshotId,
            orderId,
            error: error.message,
            updated: false
          });
        }
      }
      
      const updatedCount = updateResults.filter(r => r.updated).length;
         
      return {
        updated: updatedCount,
        total: snapshots.length,
        results: updateResults
      };
      
    } catch (error) {
      console.error(`❌ [AUTO_SYNC] Error in updateOrderSubmissionStatus:`, error);
      throw error;
    }
  }
  
  /**
   * Tự động cập nhật nhiều orders từ một batch
   */
  static async updateBatchSubmissionStatus(batchId, machineId) {
    try {
        
      // Lấy thông tin batch
      const batch = await ShippingBatch.findById(batchId).lean();
      
      if (!batch) {
       
        return { updated: 0, orders: [] };
      }
      
      if (!batch.completed || batch.completed.length === 0) {
              return { updated: 0, orders: [] };
      }
      
        
      const submissionInfo = {
        batchId: batch._id,
        batchType: batch.type,
        submittedAt: batch.createdAt,
        batchLabel: batch.label
      };
      
      const results = [];
      
      // Update từng order
      for (const completedOrder of batch.completed) {
        try {
          const result = await this.updateOrderSubmissionStatus(
            completedOrder.orderId, 
            machineId, 
            submissionInfo
          );
          
          results.push({
            orderId: completedOrder.orderId,
            ...result
          });
          
        } catch (error) {
          console.error(`❌ [AUTO_SYNC] Error updating order ${completedOrder.orderId}:`, error);
          results.push({
            orderId: completedOrder.orderId,
            error: error.message,
            updated: 0
          });
        }
      }
      
      const totalUpdated = results.reduce((sum, r) => sum + (r.updated || 0), 0);
      
         
      return {
        batchId,
        totalUpdated,
        ordersProcessed: results.length,
        results
      };
      
    } catch (error) {
         throw error;
    }
  }
  
  /**
   * Tự động cập nhật khi order bị remove khỏi batch (unsubmit)
   */
  static async updateOrderUnsubmission(orderId, machineId) {
    try {
       
      // Update với submissionInfo = null để đánh dấu chưa submit
      const result = await this.updateOrderSubmissionStatus(orderId, machineId, null);
        
      return result;
      
    } catch (error) {
        throw error;
    }
  }
  
  /**
   * Bulk sync tất cả orders trong một shop
   */
  static async bulkSyncShopSubmissionStatus(machineId) {
    try {   
      // Lấy tất cả snapshots của shop
      const snapshots = await OrderStatusSnapshot.find({
        machineId,
        isSuccess: true
      }).sort({ createdAt: -1 });
      
      if (snapshots.length === 0) {
               return { updated: 0, snapshots: 0 };
      }
      
      // Lấy tất cả submitted orders từ ShippingBatch
      const submittedBatches = await ShippingBatch.find({
        machineId
      }).lean();
      
      // Tạo map submission info
      const submissionMap = new Map();
      for (const batch of submittedBatches) {
        for (const completed of batch.completed || []) {
          submissionMap.set(completed.orderId, {
            batchId: batch._id,
            batchType: batch.type,
            submittedAt: batch.createdAt,
            batchLabel: batch.label
          });
        }
      }
         
      let totalUpdated = 0;
      const results = [];
      
      // Update từng snapshot
      for (const snapshot of snapshots) {
        try {
          let snapshotUpdated = false;
          
          // Update từng order trong snapshot
          for (let i = 0; i < snapshot.orders.length; i++) {
            const order = snapshot.orders[i];
            const submissionInfo = submissionMap.get(order.orderId);
            const isSubmitted = submissionInfo !== undefined;
            
            if (order.submittedToAmazon !== isSubmitted) {
              snapshot.orders[i].submittedToAmazon = isSubmitted;
              snapshot.orders[i].submissionInfo = submissionInfo || null;
              snapshotUpdated = true;
            }
          }
          
          if (snapshotUpdated) {
            // Recalculate stats
            snapshot.stats = this.recalculateStats(snapshot.orders);
            await snapshot.save();
            totalUpdated++;
                     }
          
          results.push({
            snapshotId: snapshot.snapshotId,
            updated: snapshotUpdated,
            ordersCount: snapshot.orders.length
          });
          
        } catch (error) {
          console.error(`❌ [AUTO_SYNC] Error updating snapshot ${snapshot.snapshotId}:`, error);
          results.push({
            snapshotId: snapshot.snapshotId,
            updated: false,
            error: error.message
          });
        }
      }
      
      return {
        totalSnapshots: snapshots.length,
        updated: totalUpdated,
        submittedOrdersFound: submissionMap.size,
        results
      };
      
    } catch (error) {
      console.error(`❌ [AUTO_SYNC] Error in bulkSyncShopSubmissionStatus:`, error);
      throw error;
    }
  }
  
  /**
   * Recalculate stats cho snapshot
   */
  static recalculateStats(orders) {
    return {
      totalScanned: orders.length,
      totalWithTracking: orders.filter(o => o.hasTracking).length,
      totalWithoutTracking: orders.filter(o => !o.hasTracking).length,
      totalSubmitted: orders.filter(o => o.submittedToAmazon).length,
      totalNotSubmitted: orders.filter(o => o.hasTracking && !o.submittedToAmazon).length,
      filteredCount: orders.length,
    };
  }
  
  /**
   * Scheduled job để sync định kỳ
   */
  static async scheduledSyncAllShops() {
    try {
       
      // Lấy danh sách shops có snapshots
      const shopsWithSnapshots = await OrderStatusSnapshot.distinct('machineId', {
        isSuccess: true
      });
      
       
      const results = [];
      
      for (const machineId of shopsWithSnapshots) {
        try {
          const result = await this.bulkSyncShopSubmissionStatus(machineId);
          results.push({
            machineId,
            success: true,
            ...result
          });
        } catch (error) {
          console.error(`❌ [AUTO_SYNC] Error syncing shop ${machineId}:`, error);
          results.push({
            machineId,
            success: false,
            error: error.message
          });
        }
      }
      
      const successCount = results.filter(r => r.success).length;
       return {
        totalShops: shopsWithSnapshots.length,
        successCount,
        results
      };
      
    } catch (error) {
      console.error(`❌ [AUTO_SYNC] Error in scheduledSyncAllShops:`, error);
      throw error;
    }
  }
}

module.exports = SnapshotAutoSyncService;