const express = require("express");
const router = express.Router();
const vendorRoutes = require("./vendor.routes");
const vendorCostCenterRoutes = require("./vendorCostCenter.routes");
const vendorProductRoutes = require("./vendorProduct.routes");

router.use("/api/vendor", vendorRoutes);
router.use("/api/vendor-cost-center", vendorCostCenterRoutes);
router.use("/api/vendor-product", vendorProductRoutes);

module.exports = router;

