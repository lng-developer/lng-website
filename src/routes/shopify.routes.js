const express = require("express");
const shopifyController = require("../controllers/shopify.controller");
const { verifyShopifyWebhook } = require("../middleware/shopifyWebhook.middleware");

const router = express.Router();

router.get("/test-connection", shopifyController.testConnection);
router.post("/orders/import", shopifyController.importOrdersDryRun);
router.post(
  "/webhooks/orders-create",
  verifyShopifyWebhook,
  shopifyController.handleOrderCreatedWebhook
);
router.post(
 "/webhooks/register",
 shopifyController.registerShopifyWebhook
);
module.exports = router;
