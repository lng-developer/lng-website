const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");
const { reportController } = require("../controllers");

// ROUTES CRUD - ACCOUNT
router.get(
  "/",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  reportController.getReportMatrix
);
router.post(
  "/import-file",
  upload.single("file"),
  reportController.importReportFromFile
);
router.get(
  "/order_cost/statistics",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  reportController.getOrderCostStatistics
);

router.get(
  "/order_cost/export",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  reportController.exportOrdersCostExcel
);

router.post(
  "/import-refund",
  upload.single("file"),
  authenticateToken,
  authorizeRoles("Admin"),
  reportController.importAmazonRefundCSV
);

router.get(
  "/ads/export",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  reportController.exportAmazonAdsSpendBySellerExcel
);

module.exports = router;
