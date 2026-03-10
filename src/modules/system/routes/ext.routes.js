const express = require("express");
const router = express.Router();
const extController = require("../controllers/ext.controller");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

// Gửi lệnh cho 1 client (theo machineId + shopId)
router.post("/command", extController.requestExtension);

// Broadcast lệnh pull orders cho tất cả client đang online
router.post("/pull-all", extController.pullAllOrder);

// List client online
router.get("/online", extController.getClientOnline);

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

module.exports = router;

