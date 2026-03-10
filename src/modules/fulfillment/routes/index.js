const express = require("express");
const router = express.Router();
const apoRoutes = require("./apo.routes");
const qcRoutes = require("./qc.routes");
const scaleRoutes = require("./scale.routes");
const shippingBatchRoutes = require("./shippingBatch.routes");

router.use("/api/fulfillment/qc", qcRoutes);
router.use("/api/scale", scaleRoutes);
router.use("/APO", apoRoutes);
router.use("/api/shipping-batches", shippingBatchRoutes);

module.exports = router;

