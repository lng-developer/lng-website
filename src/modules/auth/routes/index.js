const express = require("express");
const router = express.Router();
const userRoutes = require("./user.routes");
const accountRoutes = require("./account.routes");
const authRoutes = require("./auth.routes");
const roleRoutes = require("./role.routes");
const shopRoutes = require("./shop.routes");

router.use("/api/user", userRoutes);
router.use("/api/account", accountRoutes);
router.use("/api/auth", authRoutes);
router.use("/api/role", roleRoutes);
router.use("/api/shop", shopRoutes);

module.exports = router;

