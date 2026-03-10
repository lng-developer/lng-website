const express = require("express");
const router = express.Router();
const orderController = require("../controllers/order.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

router.use(authenticateToken);

router.get("/", orderController.getOrders);
router.get("/stats", orderController.getStatistics);
router.get("/:id", orderController.getOrderById);
router.post("/import-json", orderController.importOrderJson);
router.put("/:orderId/status", orderController.updateStatus);
router.post("/:orderId/tracking", orderController.updateItemTracking);
router.post("/:orderId/replace", orderController.createReplacementOrder);
router.post("/:orderId/compute-cost", orderController.computeBaseCost);
router.post("/:orderId/address/validate", orderController.validateAddressByOrderId);
router.post("/address/validate-batch", orderController.validateInvalidAddressesBatch);
router.post("/import-xlsx", upload.single("file"), orderController.updateFromXlsx);

module.exports = router;

