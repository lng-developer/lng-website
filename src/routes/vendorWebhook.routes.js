const express = require("express");
const vendorWebhookController = require("../controllers/vendorWebhook.controller");

const router = express.Router();

router.get("/:provider", vendorWebhookController.verifyVendorWebhookEndpoint);
router.post("/:provider", vendorWebhookController.receiveVendorWebhook);

module.exports = router;
