const express = require("express");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const adsController = require("../controllers/ads.controller");

const router = express.Router();
router.get("/", adsController.getAdsSummary);
router.post(
  "/import-day",
  upload.single("file"),
  adsController.importAdsForDay
);
module.exports = router;

