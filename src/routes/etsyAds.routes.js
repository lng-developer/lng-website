// src/routes/etsyAds.routes.js
const express = require("express");
const router = express.Router();
const { etsyAdsController } = require("../controllers");

// Extension POST ads scrape từ Etsy
// Idempotent theo (day, shopId)
router.post("/", etsyAdsController.importEtsyAds);

// Liệt kê (FE/admin)
router.get("/", etsyAdsController.listEtsyAds);

// Detail 1 doc kèm rawStats + rawListing
router.get("/:id", etsyAdsController.getEtsyAdsDetail);

module.exports = router;
