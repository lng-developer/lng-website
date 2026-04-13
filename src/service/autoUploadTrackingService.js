/**
 * Auto Upload Tracking Service
 * Query orders từ orderStatusSnapshots, nhóm theo shop và gửi task upload tracking
 */

const OrderStatusSnapshot = require("../models/orderStatusSnapshot.model");
const ShippingBatch = require("../models/shippingBatch.model");
const RealtimeLog = require("../models/realtimeLog.model");
const AutoJobLog = require("../models/autoJobLog.model");

class AutoUploadTrackingService {
  
  /**
   * Tạo file content cho upload tracking (giống logic trong manualUploadTask)
   */
  static buildShipDateString(baseDate) {
    const ref = baseDate ? new Date(baseDate) : new Date();
    const shipDate = new Date(
      Date.UTC(
        ref.getUTCFullYear(),
        ref.getUTCMonth(),
        ref.getUTCDate(),
        0,
        22,
        22,
      ),
    );
    return shipDate.toISOString().replace(".000Z", "+00:00");
  }

  static normalizeField(value) {
    if (value === null || value === undefined) return "";
    return String(value)
      .trim()
      .replace(/^"+|"+$/g, "")
      .replace(/,+$/g, "");
  }

  static buildCompletedShippingFile(orders, options = {}) {
    const {
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
      shipDate,
    } = options;

    let content = "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

    for (const order of orders) {
      if (!order.orderId || !order.tracking) continue;

      const orderId = this.normalizeField(order.orderId);
      const tracking = this.normalizeField(order.tracking);

      if (!orderId || !tracking) continue;

      let finalCarrierCode = carrierCode;
      let finalShipMethod = shipMethod;

      // Auto-detect carrier từ tracking prefix
      if (tracking.startsWith("UK") || tracking.startsWith("UL")) {
        finalCarrierCode = "Yanwen";
        finalShipMethod = "Yanwen Air Economy Mail General";
      } else if (tracking.startsWith("YT")) {
        finalCarrierCode = "Yun Express";
        finalShipMethod = "YunExpress Global Direct line (standard )-Tracked";
      }

      content += [
        orderId,
        shipDate,
        finalCarrierCode,
        tracking,
        finalShipMethod,
      ].join("\t");

      content += "\n";
    }

    return content;
  }

  /**
   * Query orders từ snapshots và nhóm theo shop
   */
  static async getOrdersGroupedByShop(options = {}) {
    try {
      const {
        maxOrdersPerShop = 50,
        onlyWithTracking = true,
        onlyNotSubmitted = false,
        excludeShops = [],
        includeShops = []
      } = options;

      console.log(`🔍 [AUTO_UPLOAD] Querying orders from snapshots...`);

      // Lấy snapshots mới nhất của từng shop
      const latestSnapshots = await OrderStatusSnapshot.aggregate([
        {
          $match: {
            isSuccess: true,
            ...(includeShops.length > 0 ? { machineId: { $in: includeShops } } : {}),
            ...(excludeShops.length > 0 ? { machineId: { $nin: excludeShops } } : {})
          }
        },
        {
          $sort: { machineId: 1, createdAt: -1 }
        },
        {
          $group: {
            _id: "$machineId",
            latestSnapshot: { $first: "$$ROOT" }
          }
        }
      ]);

      console.log(`📊 [AUTO_UPLOAD] Found ${latestSnapshots.length} shops with snapshots`);

      const shopOrdersMap = new Map();

      for (const item of latestSnapshots) {
        const snapshot = item.latestSnapshot;
        const machineId = snapshot.machineId;

        // Filter orders theo criteria
        let eligibleOrders = snapshot.orders.filter(order => {
          // Có tracking nếu yêu cầu
          if (onlyWithTracking && !order.hasTracking) return false;
          
          // Chưa submit nếu yêu cầu
          if (onlyNotSubmitted && order.submittedToAmazon) return false;
          
          // Có tracking hợp lệ
          if (!order.tracking || order.tracking === '-' || order.tracking === '---') return false;
          
          return true;
        });

        // Limit số orders per shop
        if (eligibleOrders.length > maxOrdersPerShop) {
          eligibleOrders = eligibleOrders.slice(0, maxOrdersPerShop);
        }

        if (eligibleOrders.length > 0) {
          shopOrdersMap.set(machineId, {
            machineId,
            shopName: snapshot.orders[0]?.shopName || `Shop ${machineId}`,
            snapshotId: snapshot.snapshotId,
            snapshotCreatedAt: snapshot.createdAt,
            orders: eligibleOrders,
            totalOrders: eligibleOrders.length
          });
        }
      }

      console.log(`✅ [AUTO_UPLOAD] Processed ${shopOrdersMap.size} shops with eligible orders`);

      return shopOrdersMap;

    } catch (error) {
      console.error(`❌ [AUTO_UPLOAD] Error querying orders:`, error.message);
      throw error;
    }
  }

  /**
   * Tạo batch từ orders của một shop
   */
  static async createBatchForShop(machineId, orders, options = {}) {
    try {
      const { label, batchType = "AUTO_UPLOAD" } = options;

      console.log(`📦 [AUTO_UPLOAD] Creating batch for shop ${machineId} with ${orders.length} orders`);

      // Chuẩn bị completed orders
      const completed = orders.map(order => ({
        orderId: order.orderId,
        tracking: order.tracking,
        isFake: false,
        source: "system",
        createdAt: new Date()
      }));

      // Tạo batch
      const batch = await ShippingBatch.create({
        machineId,
        label: label || `Auto Upload - ${new Date().toISOString().split('T')[0]} - ${orders.length} orders`,
        type: "CONFIRM", // Sử dụng type hợp lệ
        status: "CONFIRM_FILE_READY",
        completed,
        tracking_fakes: [],
        stats: {
          totalOrders: completed.length,
          totalReal: completed.length,
          totalFake: 0
        },
        // Metadata cho auto upload
        autoUploadInfo: {
          createdByAutoUpload: true,
          sourceType: "orderStatusSnapshots",
          createdAt: new Date()
        }
      });

      console.log(`✅ [AUTO_UPLOAD] Created batch ${batch._id} for shop ${machineId}`);

      return batch;

    } catch (error) {
      console.error(`❌ [AUTO_UPLOAD] Error creating batch for shop ${machineId}:`, error.message);
      throw error;
    }
  }

  /**
   * Gửi upload task đến extension (giống logic manualUploadTask)
   */
  static async sendUploadTaskToExtension(batch, orders, io, options = {}) {
    try {
      const {
        carrierCode = "USPS",
        shipMethod = "USPS First Class",
        shipDate
      } = options;

      const machineId = batch.machineId;

      console.log(`📡 [AUTO_UPLOAD] Starting sendUploadTaskToExtension for batch ${batch._id}`);
      console.log(`📡 [AUTO_UPLOAD] Parameters:`, {
        batchId: batch._id,
        machineId,
        ordersCount: orders.length,
        carrierCode,
        shipMethod,
        shipDate,
        ioAvailable: !!io
      });

      if (!io) {
        console.error(`❌ [AUTO_UPLOAD] Socket.IO instance is null/undefined!`);
        throw new Error("Socket.IO instance not available");
      }

      if (!machineId) {
        console.error(`❌ [AUTO_UPLOAD] machineId is null/undefined for batch ${batch._id}`);
        throw new Error("machineId is required");
      }

      // Tạo file content
      const shipDateBase = shipDate ? new Date(shipDate) : (batch.createdAt ? new Date(batch.createdAt) : new Date());
      const shipDateStr = this.buildShipDateString(shipDateBase);
      
      console.log(`📡 [AUTO_UPLOAD] Building file content with shipDate: ${shipDateStr}`);
      
      const fileContent = this.buildCompletedShippingFile(orders, {
        carrierCode,
        shipMethod,
        shipDate: shipDateStr,
      });

      const filename = `auto_upload_${machineId}_${batch._id}.txt`;

      console.log(`📡 [AUTO_UPLOAD] File created:`, {
        filename,
        contentLength: fileContent.length,
        fileSize: Buffer.byteLength(fileContent, 'utf8')
      });

      // Chuẩn bị tracking data
      const trackingData = orders.map(order => ({
        orderId: order.orderId,
        tracking: order.tracking,
        isFake: false,
        source: 'system'
      }));

      console.log(`📡 [AUTO_UPLOAD] Tracking data prepared:`, {
        trackingCount: trackingData.length,
        sampleTracking: trackingData.slice(0, 3)
      });

      // Tạo task
      const task = {
        type: "UPLOAD_TRACKING",
        payload: {
          batchId: batch._id,
          machineId,
          label: batch.label,
          trackingData,
          stats: batch.stats,

          // File information
          file: {
            filename,
            content: fileContent,
            contentType: "text/tab-separated-values; charset=utf-8",
            size: Buffer.byteLength(fileContent, 'utf8')
          },

          // Upload parameters
          uploadParams: {
            carrierCode,
            shipMethod,
            shipDate: shipDateStr
          },

          autoGenerated: true, // Đánh dấu là auto generated
          reason: "auto_upload_from_snapshots",
          requestedBy: "auto_service",
          timestamp: new Date().toISOString()
        }
      };

      console.log(`📡 [AUTO_UPLOAD] Task payload created:`, {
        type: task.type,
        batchId: task.payload.batchId,
        machineId: task.payload.machineId,
        trackingCount: task.payload.trackingData.length,
        filename: task.payload.file.filename,
        fileSize: task.payload.file.size,
        autoGenerated: task.payload.autoGenerated
      });

      // Kiểm tra Socket.IO rooms trước khi gửi
      const roomName = `machine:${machineId}`;
      const roomSockets = io.sockets.adapter.rooms.get(roomName);
      const roomSize = roomSockets ? roomSockets.size : 0;
      
      console.log(`📡 [AUTO_UPLOAD] Socket.IO room info:`, {
        roomName,
        roomSize,
        hasClients: roomSize > 0,
        allRooms: Array.from(io.sockets.adapter.rooms.keys()).filter(r => r.startsWith('machine:')),
        totalSockets: io.sockets.sockets.size
      });

      // Gửi task qua Socket.IO
      console.log(`📡 [AUTO_UPLOAD] Emitting task to room: ${roomName}`);
      io.to(roomName).emit("server:task", task);
      console.log(`📡 [AUTO_UPLOAD] Task emitted successfully to ${roomName}`);

      // Đánh dấu batch đã gửi task
      batch.uploadTaskSent = true;
      batch.uploadTaskSentAt = new Date();
      batch.uploadTaskSentBy = "auto"; // Sử dụng enum value hợp lệ
      await batch.save();

      console.log(`📡 [AUTO_UPLOAD] Batch updated:`, {
        batchId: batch._id,
        uploadTaskSent: batch.uploadTaskSent,
        uploadTaskSentAt: batch.uploadTaskSentAt,
        uploadTaskSentBy: batch.uploadTaskSentBy
      });

      // Log task
      await RealtimeLog.create({
        machineId,
        label: batch.label,
        action: "auto", // Sử dụng enum value hợp lệ
        level: "info",
        message: `Auto UPLOAD_TRACKING task sent: ${trackingData.length} orders, file: ${filename}`,
        ts: new Date(),
      });

      console.log(`✅ [AUTO_UPLOAD] Sent task for batch ${batch._id} to ${roomName} with ${roomSize} clients`);

      return {
        success: true,
        batchId: batch._id,
        filename,
        fileSize: Buffer.byteLength(fileContent, 'utf8'),
        trackingCount: trackingData.length,
        target: roomName,
        roomSize
      };

    } catch (error) {
      console.error(`❌ [AUTO_UPLOAD] Error sending task for batch ${batch._id}:`, error.message);
      console.error(`❌ [AUTO_UPLOAD] Error stack:`, error.stack);
      throw error;
    }
  }

  /**
   * Main function: Auto upload tracking cho tất cả shops
   */
  static async autoUploadTrackingForAllShops(io, options = {}, jobLog = null) {
    console.log(`🚀 [AUTO_UPLOAD] Starting autoUploadTrackingForAllShops`);
    console.log(`🚀 [AUTO_UPLOAD] Socket.IO instance check:`, {
      ioProvided: !!io,
      ioType: typeof io,
      ioSocketsCount: io?.sockets?.sockets?.size || 'unknown',
      ioAdapterRoomsCount: io?.sockets?.adapter?.rooms?.size || 'unknown',
      ioConstructorName: io?.constructor?.name || 'unknown'
    });
    console.log(`🚀 [AUTO_UPLOAD] Options:`, options);

    try {
      const startTime = new Date();
      console.log(`🚀 [AUTO_UPLOAD] Starting auto upload tracking at ${startTime.toISOString()}`);

      if (jobLog) {
        await jobLog.addLog('info', 'Starting auto upload tracking from snapshots', {
          startTime: startTime.toISOString(),
          options
        });
      }

      const {
        maxOrdersPerShop = 50,
        onlyWithTracking = true,
        onlyNotSubmitted = true, // Chỉ upload orders chưa submit
        excludeShops = [],
        includeShops = [],
        carrierCode = "USPS",
        shipMethod = "USPS First Class",
        dryRun = false
      } = options;

      // 1. Query orders nhóm theo shop
      const shopOrdersMap = await this.getOrdersGroupedByShop({
        maxOrdersPerShop,
        onlyWithTracking,
        onlyNotSubmitted,
        excludeShops,
        includeShops
      });

      if (jobLog) {
        await jobLog.addLog('info', 'Orders queried from snapshots', {
          totalShops: shopOrdersMap.size,
          shopIds: Array.from(shopOrdersMap.keys())
        });
      }

      if (shopOrdersMap.size === 0) {
        console.log(`⚠️ [AUTO_UPLOAD] No eligible orders found for upload`);
        
        if (jobLog) {
          await jobLog.addLog('warning', 'No eligible orders found for upload', {
            reason: 'No shops with eligible orders in snapshots'
          });
        }

        return {
          success: true,
          totalShops: 0,
          totalOrders: 0,
          results: [],
          message: "No eligible orders found"
        };
      }

      const results = [];
      let totalOrders = 0;

      // 2. Process từng shop
      for (const [machineId, shopData] of shopOrdersMap) {
        try {
          console.log(`🔄 [AUTO_UPLOAD] Processing shop ${machineId} (${shopData.totalOrders} orders)`);

          if (jobLog) {
            await jobLog.addLog('info', `Processing shop ${machineId}`, {
              machineId,
              shopName: shopData.shopName,
              ordersCount: shopData.totalOrders,
              snapshotId: shopData.snapshotId
            });
          }

          if (dryRun) {
            console.log(`🧪 [DRY_RUN] Would create batch and send task for shop ${machineId}`);
            
            if (jobLog) {
              await jobLog.addLog('info', `DRY RUN - Would process shop ${machineId}`, {
                machineId,
                ordersCount: shopData.totalOrders,
                dryRun: true
              });
            }

            results.push({
              machineId,
              shopName: shopData.shopName,
              success: true,
              dryRun: true,
              ordersCount: shopData.totalOrders,
              message: "Dry run - no actual upload"
            });
            totalOrders += shopData.totalOrders;
            continue;
          }

          // Tạo batch cho shop
          const batch = await this.createBatchForShop(machineId, shopData.orders, {
            label: `Auto Upload - ${shopData.shopName} - ${shopData.totalOrders} orders`
          });

          if (jobLog) {
            await jobLog.addLog('info', `Created batch for shop ${machineId}`, {
              batchId: batch._id,
              machineId,
              ordersCount: shopData.totalOrders
            });
          }

          // Gửi upload task
          console.log(`🚀 [AUTO_UPLOAD] About to call sendUploadTaskToExtension:`, {
            batchId: batch._id,
            machineId,
            ordersCount: shopData.orders.length,
            ioAvailable: !!io,
            ioType: typeof io,
            ioSocketsCount: io?.sockets?.sockets?.size || 'unknown'
          });

          const taskResult = await this.sendUploadTaskToExtension(batch, shopData.orders, io, {
            carrierCode,
            shipMethod
          });

          console.log(`✅ [AUTO_UPLOAD] sendUploadTaskToExtension completed:`, {
            success: taskResult.success,
            batchId: taskResult.batchId,
            filename: taskResult.filename,
            target: taskResult.target,
            roomSize: taskResult.roomSize
          });

          if (jobLog) {
            await jobLog.addLog('info', `Upload task sent for shop ${machineId}`, {
              batchId: batch._id,
              machineId,
              filename: taskResult.filename,
              fileSize: taskResult.fileSize,
              target: taskResult.target,
              success: taskResult.success
            });
          }

          results.push({
            machineId,
            shopName: shopData.shopName,
            success: true,
            batchId: batch._id,
            ordersCount: shopData.totalOrders,
            filename: taskResult.filename,
            fileSize: taskResult.fileSize,
            target: taskResult.target,
            snapshotId: shopData.snapshotId
          });

          totalOrders += shopData.totalOrders;

        } catch (shopError) {
          console.error(`❌ [AUTO_UPLOAD] Error processing shop ${machineId}:`, shopError.message);
          
          if (jobLog) {
            await jobLog.addLog('error', `Error processing shop ${machineId}`, {
              machineId,
              error: shopError.message,
              stack: shopError.stack
            });
          }

          results.push({
            machineId,
            shopName: shopData.shopName,
            success: false,
            error: shopError.message,
            ordersCount: shopData.totalOrders
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const endTime = new Date();
      const duration = endTime - startTime;

      console.log(`🎉 [AUTO_UPLOAD] Completed: ${successCount}/${shopOrdersMap.size} shops, ${totalOrders} total orders in ${duration}ms`);

      if (jobLog) {
        await jobLog.addLog('info', 'Auto upload tracking completed', {
          endTime: endTime.toISOString(),
          duration,
          totalShops: shopOrdersMap.size,
          successfulShops: successCount,
          failedShops: shopOrdersMap.size - successCount,
          totalOrders,
          results
        });
      }

      return {
        success: true,
        totalShops: shopOrdersMap.size,
        successfulShops: successCount,
        failedShops: shopOrdersMap.size - successCount,
        totalOrders,
        duration,
        results,
        message: `Auto upload completed: ${successCount} shops, ${totalOrders} orders`
      };

    } catch (error) {
      console.error(`❌ [AUTO_UPLOAD] Auto upload failed:`, error.message);
      
      if (jobLog) {
        await jobLog.addLog('error', 'Auto upload tracking failed', {
          error: error.message,
          stack: error.stack
        });
      }

      throw error;
    }
  }

  /**
   * Auto upload cho một shop cụ thể
   */
  static async autoUploadTrackingForShop(machineId, io, options = {}) {
    try {
      console.log(`🎯 [AUTO_UPLOAD] Auto upload for specific shop: ${machineId}`);

      const result = await this.autoUploadTrackingForAllShops(io, {
        ...options,
        includeShops: [machineId]
      });

      const shopResult = result.results.find(r => r.machineId === machineId);

      return {
        success: shopResult?.success || false,
        machineId,
        ...shopResult,
        message: shopResult ? 
          `Auto upload for shop ${machineId}: ${shopResult.success ? 'success' : 'failed'}` :
          `No eligible orders found for shop ${machineId}`
      };

    } catch (error) {
      console.error(`❌ [AUTO_UPLOAD] Auto upload failed for shop ${machineId}:`, error.message);
      throw error;
    }
  }
}

module.exports = AutoUploadTrackingService;