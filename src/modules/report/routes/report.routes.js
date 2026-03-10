const express = require("express");
const router = express.Router();
const reportController = require("../controllers/report.controller");
const adsController = require("../controllers/ads.controller");
const etsyReportController = require("../controllers/etsyReport.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

router.use(authenticateToken);

router.post("/amazon/import", upload.single("file"), reportController.importReportFromFile);
router.get("/amazon/matrix", reportController.getReportMatrix);
router.get("/amazon/stats", reportController.getOrderCostStatistics);
router.post("/amazon/import-refund", upload.single("file"), reportController.importAmazonRefundCSV);
router.get("/amazon/export-cost", reportController.exportOrdersCostExcel);
router.get("/amazon/export-ads-spend", reportController.exportAmazonAdsSpendBySellerExcel);

router.post("/ads/import", upload.single("file"), adsController.importAdsForDay);
router.get("/ads/summary", adsController.getAdsSummary);

router.get("/etsy/matrix", etsyReportController.getEtsyReportMatrix);

module.exports = router;

