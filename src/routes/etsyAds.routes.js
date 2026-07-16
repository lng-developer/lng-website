// src/routes/etsyAds.routes.js
const express = require("express");
const router = express.Router();
const { etsyAdsController } = require("../controllers");

// Extension POST ads scrape từ Etsy
// Idempotent theo (day, shopId)
router.post("/", etsyAdsController.importEtsyAds);

// Liệt kê (FE/admin)
router.get("/", etsyAdsController.listEtsyAds);

// Liệt kê theo mã nhân viên, dùng cùng query params với list API
router.get("/by-employee", etsyAdsController.listEtsyAdsByEmployee);

// Detail 1 doc kèm rawStats + rawListing
router.get("/:id", etsyAdsController.getEtsyAdsDetail);

module.exports = router;
