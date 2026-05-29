// src/routes/ext.routes.js
const express = require("express");
const router = express.Router();
const { extController } = require("../controllers");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// Gửi lệnh cho 1 client (theo machineId + shopId)
router.post("/command", extController.requestExtension);
router.post("/etsy/upload-tracking", extController.etsyUploadTracking);
router.post("/etsy/upload-tracking-batch", extController.etsyUploadTrackingBatch);

// Broadcast lệnh pull orders cho tất cả client đang online
router.post("/pull-all", extController.pullAllOrder);

// List client online
router.get("/online", extController.getClientOnline);

// ================= TWO-WAY COMMUNICATION =================

// REST fallback: extension báo task status khi socket lỗi (idempotent theo eventId)
// body: { eventId, taskId, status, type?, shopId?, machineId?, result?, error?, source?, reportedAt? }
router.post("/task-result", extController.taskResultRest);

// Test connection với specific client
router.post("/test-connection/:machineId", extController.testConnection);

// Broadcast message tới tất cả clients trong shop
router.post("/broadcast", extController.broadcastMessage);

// ================= AUTO REQUEST EXTENSION =================

// Auto request extension cho tất cả shops
// body: { type: "IMPORT_ORDERS", payload?: any, action?: string, label?: string }
router.post("/request-extension/auto-all", extController.autoRequestExtensionAll);

// ================= VENDOR SYNC TRACKING =================

// Sync tracking cho 1 đơn cụ thể
// body: { orderId: "113-xxxxxx-xxxxxxx" }
router.post("/vendor-sync/one", extController.vendorSyncOne);

// Sync tracking cho list đơn
// body: { orderIds: ["113-xxx-xxx", "114-yyy-yyy"] }
router.post("/vendor-sync/list", extController.vendorSyncList);

// Chạy batch tự động (lọc theo vendorProductId, giống script batch)
// body: { max?: number, dryRun?: boolean }
router.post("/vendor-sync/batch", extController.vendorSyncBatch);

// ================= ETSY VENDOR SYNC TRACKING =================

// Sync tracking Etsy cho 1 order
// body: { orderId: "xxx", shopId?: "..." }
router.post("/etsy/vendor-sync/one", extController.etsyVendorSyncOne);

// Sync tracking Etsy cho list order
// body: { orderIds: ["xxx", "yyy"], shopId?: "..." }
router.post("/etsy/vendor-sync/list", extController.etsyVendorSyncList);

// Chay batch sync tracking Etsy tu collection etsyorders
// body: { max?: number, dryRun?: boolean, shopId?: string, status?: string }
router.post("/etsy/vendor-sync/batch", extController.etsyVendorSyncBatch);

module.exports = router;
