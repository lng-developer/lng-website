const express = require("express");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { APOController } = require("../controllers");

const router = express.Router();
router.post("/ext/import-orders", upload.any(), APOController.importOrders);
router.post("/ext/report-orders", upload.any(), APOController.reportOrders);
router.post("/ext/ads-spend", upload.any(), APOController.adsSpend);
module.exports = router;
