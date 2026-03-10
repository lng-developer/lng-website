const express = require("express");
const router = express.Router();
const amazonOrderRoutes = require("./amazonOrder.routes");
const etsyOrderRoutes = require("./etsyOrder.routes");

router.use("/api/order", amazonOrderRoutes);
router.use("/api/etsy", etsyOrderRoutes);

module.exports = router;

