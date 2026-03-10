const express = require("express");
const router = express.Router();
const listingRoutes = require("./listing.routes");
const productTypeRoutes = require("./productType.routes");
const skuMappingRoutes = require("./skuMapping.routes");
const etsyListingRoutes = require("./etsyListing.routes");

router.use("/api/listing", listingRoutes);
router.use("/api/product-type", productTypeRoutes);
router.use("/api/sku-mapping", skuMappingRoutes);
router.use("/api/etsy-listing", etsyListingRoutes);

module.exports = router;

