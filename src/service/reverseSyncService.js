/**
 * Reverse Sync Service - Ánh xạ ngược từ OrderStatusSnapshot → ShippingBatch
 * Để implement ánh xạ 2 chiều cho submittedToAmazon status
 */

const OrderStatusSnapshot = require("../models/orderStatusSnapshot.model");
const ShippingBatch = require("../models/shippingBatch.model");
const OrderCustomProduct = require("../models/orderCustomProduct.model");

class ReverseSyncService {
  
  /**
   * Tạo ShippingBatch từ manual submission update trong snapshot
   */
  static async createBatchFromManualSubmission(orderId, machineId, submissionInfo) {
    try {
      console.log(`🔄 [REVERSE_SYNC] Creating batch from manual submission: ${orderId}`);
      
      // 1. Kiểm tra xem order đã có trong batch nào chưa
      const existingBatch = await ShippingBatch.findOne({
        machineId,
        "completed.orderId": orderId
      });
      
      if (existingBatch) {
        console.log(`⚠️ [REVERSE_SYNC] Order ${orderId} already exists in batch ${existingBatch._id}`);
        return { 
          success: false, 
          reason: "order_already_in_batch",
          existingBatchId: existingBatch._id 
        };
      }
      
      // 2. Lấy thông tin order từ database
      const orderInfo = await OrderCustomProduct.findOne({ orderId }).lean();
      
      if (!orderInfo) {
        console.log(`❌ [REVERSE_SYNC] Order ${orderId} not found in database`);
        return { 
          success: false, 
          reason: "order_not_found" 
        };
      }
      
      // 3. Lấy tracking info
      let tracking = null;
      if (orderInfo.items && orderInfo.items.length > 0) {
        for (const item of orderInfo.items) {
          if (item.tracking_info?.tracking && 
              item.tracking_info.tracking !== '-' && 
              item.tracking_info.tracking !== '---') {
            tracking = item.tracking_info.tracking;
            break;
          }
        }
      }
      
      if (!tracking) {
        console.log(`⚠️ [REVERSE_SYNC] Order ${orderId} has no tracking info`);
        // Vẫn tạo batch nhưng đánh dấu là không có tracking
      }
      
      // 4. Tạo batch mới cho manual submission
      const batch = await ShippingBatch.create({
        machineId,
        label: `Manual Submission - ${orderId}`,
        type: "CONFIRM", // Sử dụng type hợp lệ
        status: "CONFIRM_FILE_READY",
        completed: [{
          orderId,
          tracking: tracking || "NO_TRACKING",
          isFake: !tracking, // Nếu không có tracking thì đánh dấu fake
          source: "system", // Sử dụng source hợp lệ
          createdAt: new Date()
        }],
        tracking_fakes: tracking ? [] : [{
          orderId,
          note: "Manual submission without tracking",
          createdAt: new Date()
        }],
        stats: {
          totalOrders: 1,
          totalReal: tracking ? 1 : 0,
          totalFake: tracking ? 0 : 1
        },
        // Metadata cho reverse sync
        reverseSyncInfo: {
          createdFromSnapshot: true,
          originalSubmissionInfo: submissionInfo,
          createdAt: new Date()
        }
      });
      
      console.log(`✅ [REVERSE_SYNC] Created batch ${batch._id} for manual submission of order ${orderId}`);
      
      return {
        success: true,
        batchId: batch._id,
        batchType: batch.type,
        hasTracking: !!tracking
      };
      
    } catch (error) {
      console.error(`❌ [REVERSE_SYNC] Error creating batch from manual submission:`, error.message);
      throw error;
    }
  }
  
  /**
   * Remove order từ ShippingBatch khi unsubmit trong snapshot
   */
  static async removeBatchFromManualUnsubmission(orderId, machineId) {
    try {
      console.log(`🔄 [REVERSE_SYNC] Removing order from batch: ${orderId}`);
      
      // 1. Tìm batches chứa order này
      const batchesWithOrder = await ShippingBatch.find({
        machineId,
        "completed.orderId": orderId
      });
      
      if (batchesWithOrder.length === 0) {
        console.log(`⚠️ [REVERSE_SYNC] Order ${orderId} not found in any batches`);
        return { 
          success: false, 
          reason: "order_not_in_batch" 
        };
      }
      
      const results = [];
      
      // 2. Process từng batch
      for (const batch of batchesWithOrder) {
        try {
          // Remove order từ completed array
          const originalCompletedCount = batch.completed.length;
          batch.completed = batch.completed.filter(item => item.orderId !== orderId);
          
          // Remove từ tracking_fakes nếu có
          if (batch.tracking_fakes) {
            batch.tracking_fakes = batch.tracking_fakes.filter(item => item.orderId !== orderId);
          }
          
          // Update stats
          batch.stats.totalOrders = batch.completed.length + (batch.tracking_fakes?.length || 0);
          batch.stats.totalReal = batch.completed.filter(item => !item.isFake).length;
          batch.stats.totalFake = batch.completed.filter(item => item.isFake).length + (batch.tracking_fakes?.length || 0);
          
          // Nếu batch trống sau khi remove, xóa luôn batch
          if (batch.completed.length === 0 && (!batch.tracking_fakes || batch.tracking_fakes.length === 0)) {
            await ShippingBatch.deleteOne({ _id: batch._id });
            console.log(`🗑️ [REVERSE_SYNC] Deleted empty batch ${batch._id}`);
            
            results.push({
              batchId: batch._id,
              action: "deleted",
              reason: "batch_empty_after_removal"
            });
          } else {
            // Save updated batch
            await batch.save();
            console.log(`✅ [REVERSE_SYNC] Updated batch ${batch._id}, removed order ${orderId}`);
            
            results.push({
              batchId: batch._id,
              action: "updated",
              removedOrders: originalCompletedCount - batch.completed.length,
              remainingOrders: batch.completed.length
            });
          }
          
        } catch (batchError) {
          console.error(`❌ [REVERSE_SYNC] Error processing batch ${batch._id}:`, batchError.message);
          results.push({
            batchId: batch._id,
            action: "error",
            error: batchError.message
          });
        }
      }
      
      console.log(`✅ [REVERSE_SYNC] Processed ${batchesWithOrder.length} batches for order ${orderId} removal`);
      
      return {
        success: true,
        processedBatches: batchesWithOrder.length,
        results
      };
      
    } catch (error) {
      console.error(`❌ [REVERSE_SYNC] Error removing order from batches:`, error.message);
      throw error;
    }
  }
  
  /**
   * Bulk reverse sync cho nhiều orders
   */
  static async bulkReverseSync(machineId, orderChanges) {
    try {
      console.log(`🔄 [REVERSE_SYNC] Starting bulk reverse sync for ${orderChanges.length} orders`);
      
      const results = {
        processed: 0,
        successful: 0,
        failed: 0,
        details: []
      };
      
      for (const change of orderChanges) {
        try {
          const { orderId, submittedToAmazon, submissionInfo } = change;
          
          let result;
          if (submittedToAmazon) {
            // Create batch for submission
            result = await this.createBatchFromManualSubmission(orderId, machineId, submissionInfo);
          } else {
            // Remove from batch for unsubmission
            result = await this.removeBatchFromManualUnsubmission(orderId, machineId);
          }
          
          results.processed++;
          if (result.success) {
            results.successful++;
          } else {
            results.failed++;
          }
          
          results.details.push({
            orderId,
            action: submittedToAmazon ? 'submit' : 'unsubmit',
            success: result.success,
            ...result
          });
          
        } catch (orderError) {
          console.error(`❌ [REVERSE_SYNC] Error processing order ${change.orderId}:`, orderError.message);
          results.processed++;
          results.failed++;
          results.details.push({
            orderId: change.orderId,
            success: false,
            error: orderError.message
          });
        }
      }
      
      console.log(`✅ [REVERSE_SYNC] Bulk sync completed: ${results.successful}/${results.processed} successful`);
      
      return results;
      
    } catch (error) {
      console.error(`❌ [REVERSE_SYNC] Bulk reverse sync failed:`, error.message);
      throw error;
    }
  }
  
  /**
   * Detect conflicts giữa snapshot và batch
   */
  static async detectSubmissionConflicts(machineId) {
    try {
      console.log(`🔍 [REVERSE_SYNC] Detecting submission conflicts for shop: ${machineId}`);
      
      // 1. Lấy latest snapshot
      const latestSnapshot = await OrderStatusSnapshot.findOne({
        machineId,
        isSuccess: true
      }).sort({ createdAt: -1 });
      
      if (!latestSnapshot) {
        return { conflicts: [], message: "No snapshots found" };
      }
      
      // 2. Lấy tất cả batches
      const allBatches = await ShippingBatch.find({ machineId });
      
      // 3. Tạo map của batch submissions
      const batchSubmissions = new Set();
      allBatches.forEach(batch => {
        batch.completed?.forEach(order => {
          batchSubmissions.add(order.orderId);
        });
      });
      
      // 4. So sánh với snapshot
      const conflicts = [];
      latestSnapshot.orders.forEach(order => {
        const inSnapshot = order.submittedToAmazon;
        const inBatch = batchSubmissions.has(order.orderId);
        
        if (inSnapshot !== inBatch) {
          conflicts.push({
            orderId: order.orderId,
            snapshotStatus: inSnapshot,
            batchStatus: inBatch,
            conflictType: inSnapshot ? 'snapshot_submitted_batch_not' : 'batch_submitted_snapshot_not'
          });
        }
      });
      
      console.log(`🔍 [REVERSE_SYNC] Found ${conflicts.length} conflicts`);
      
      return {
        conflicts,
        totalOrders: latestSnapshot.orders.length,
        conflictRate: (conflicts.length / latestSnapshot.orders.length * 100).toFixed(1)
      };
      
    } catch (error) {
      console.error(`❌ [REVERSE_SYNC] Error detecting conflicts:`, error.message);
      throw error;
    }
  }
  
  /**
   * Resolve conflicts bằng cách sync từ snapshot → batch
   */
  static async resolveConflictsFromSnapshot(machineId) {
    try {
      console.log(`🔧 [REVERSE_SYNC] Resolving conflicts by syncing snapshot → batch`);
      
      // 1. Detect conflicts
      const conflictAnalysis = await this.detectSubmissionConflicts(machineId);
      
      if (conflictAnalysis.conflicts.length === 0) {
        return { message: "No conflicts to resolve", resolved: 0 };
      }
      
      // 2. Prepare changes for bulk sync
      const orderChanges = conflictAnalysis.conflicts.map(conflict => ({
        orderId: conflict.orderId,
        submittedToAmazon: conflict.snapshotStatus,
        submissionInfo: conflict.snapshotStatus ? {
          resolvedFromConflict: true,
          resolvedAt: new Date(),
          originalConflictType: conflict.conflictType
        } : null
      }));
      
      // 3. Execute bulk reverse sync
      const syncResult = await this.bulkReverseSync(machineId, orderChanges);
      
      console.log(`✅ [REVERSE_SYNC] Resolved ${syncResult.successful}/${conflictAnalysis.conflicts.length} conflicts`);
      
      return {
        totalConflicts: conflictAnalysis.conflicts.length,
        resolved: syncResult.successful,
        failed: syncResult.failed,
        details: syncResult.details
      };
      
    } catch (error) {
      console.error(`❌ [REVERSE_SYNC] Error resolving conflicts:`, error.message);
      throw error;
    }
  }
}

module.exports = ReverseSyncService;