const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { shippingBatchController } = require("../controllers");

// ✅ Debug endpoint
// const { debugSocketRooms } = require("../../debug-socket-rooms");
// router.get("/debug/socket-rooms", debugSocketRooms);

router.post(
  "/",
  upload.single("file"),
  shippingBatchController.createBatchFromFile
);
router.get("/", shippingBatchController.listShippingBatches);
router.post(
  "/:batchId/update-from-system",
  shippingBatchController.createUpdateBatchFromSystem
);
router.get("/:batchId/download", shippingBatchController.downloadCompletedFile);

// COMMENTED OUT - removed fake tracking logic
// router.post("/update-all-fake", shippingBatchController.updateAllFakeTracking);

// COMMENTED OUT - removed fake tracking logic
// router.get(
//   "/download-all-updated",
//   shippingBatchController.downloadAllUpdatedFakeFile
// );

// ✅ Route mới: Export orders có tracking trực tiếp
router.post(
  "/export-orders-with-tracking",
  shippingBatchController.exportOrdersWithTracking
);

// ✅ Route mới: Kiểm tra trạng thái orders
router.get(
  "/check-orders-status",
  shippingBatchController.checkOrdersStatus
);

// ✅ Route mới: FE gửi task UPLOAD_TRACKING thủ công
router.post(
  "/manual-upload-task",
  shippingBatchController.manualUploadTask
);

// ✅ Route mới: FE lấy danh sách batch có thể upload
router.get(
  "/uploadable",
  shippingBatchController.getUploadableBatches
);

// ✅ Route mới: FE tạo batch từ danh sách orders
router.post(
  "/create-from-orders",
  shippingBatchController.createBatchFromOrders
);

// ✅ Route mới: Auto upload tracking
router.post(
  "/auto-upload-tracking",
  shippingBatchController.autoUploadTracking
);

// ✅ Route mới: Kiểm tra trạng thái auto upload
router.get(
  "/auto-upload-status",
  shippingBatchController.getAutoUploadStatus
);

// ✅ Order Status Sync Routes
// Sync order status cho một shop cụ thể
router.post(
  "/sync-order-status/:machineId",
  shippingBatchController.syncOrderStatusForShop
);

// Lấy danh sách snapshots cho một shop
router.get(
  "/order-status-snapshots/:machineId",
  shippingBatchController.getOrderStatusSnapshots
);

// Lấy snapshot mới nhất cho một shop
router.get(
  "/latest-order-status-snapshot/:machineId",
  shippingBatchController.getLatestOrderStatusSnapshot
);

// Chạy sync thủ công cho tất cả shops
router.post(
  "/sync-all-order-status",
  shippingBatchController.runOrderStatusSyncManually
);

// ✅ Snapshot Auto Sync Routes
// Bulk sync submission status cho một shop
router.post(
  "/bulk-sync-submission-status/:machineId",
  shippingBatchController.bulkSyncSnapshotSubmissionStatus
);

// Cập nhật submission status cho một order cụ thể
router.put(
  "/update-order-submission/:machineId/:orderId",
  shippingBatchController.updateOrderSubmissionStatusManually
);

// ✅ NEW: Bulk submission management routes
// Bulk remove orders from submission status
router.post(
  "/bulk-remove-submission",
  shippingBatchController.bulkRemoveOrdersFromSubmission
);

// Check submission status for multiple orders
router.post(
  "/check-submission-status",
  shippingBatchController.checkOrdersSubmissionStatus
);

// ✅ Quick fix: Remove specific order from all batches
// TODO: Implement quickRemoveOrderFromBatches function
// router.delete(
//   "/remove-order/:machineId/:orderId",
//   shippingBatchController.quickRemoveOrderFromBatches
// );

module.exports = router;
