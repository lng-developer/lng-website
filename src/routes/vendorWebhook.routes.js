const express = require("express");
const vendorWebhookController = require("../controllers/vendorWebhook.controller");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");

const router = express.Router();

router.get(
  "/logs",
  authenticateToken,
  authorizeRoles("Admin"),
  vendorWebhookController.listVendorWebhookLogs
);

router.get("/:provider", vendorWebhookController.verifyVendorWebhookEndpoint);
router.post("/:provider", vendorWebhookController.receiveVendorWebhook);

module.exports = router;
