const express = require("express");
const vendorWebhookController = require("../controllers/vendorWebhook.controller");

const router = express.Router();

router.post("/:provider", vendorWebhookController.receiveVendorWebhook);

module.exports = router;
