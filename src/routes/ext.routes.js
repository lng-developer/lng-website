// src/routes/ext.routes.js
const express = require("express");
const router = express.Router();
const { extController } = require("../controllers");
const { orderCustomProductController } = require("../controllers");
const { reportController } = require("../controllers");
const { adsController } = require("../controllers");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

router.post("/command", extController.requestExtension);

router.get("/online", extController.getClientOnline);

router.get("/logs", extController.getLogs);

router.post(
  "/import-order",
  orderCustomProductController.upload.single("file"),
  orderCustomProductController.updateOrdersFromXlsxEnqueue
);

router.post(
  "/import-report",
  upload.single("file"),
  reportController.importReportFromFileEnqueue
);

router.post(
  "/import-ads",
  upload.single("file"),
  adsController.importAdsForDayEnqueue
);

module.exports = router;
