const express = require("express");
const router = express.Router();
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");
const { reportController } = require("../controllers");

// ROUTES CRUD - ACCOUNT
router.get(
  "/",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  reportController.getDailyReport
);

module.exports = router;
