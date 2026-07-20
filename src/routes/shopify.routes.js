const express = require("express");
const shopifyController = require("../controllers/shopify.controller");
const { verifyShopifyWebhook } = require("../middleware/shopifyWebhook.middleware");

const router = express.Router();

router.get("/auth", shopifyController.shopifyAuth);
router.get("/auth/callback", shopifyController.shopifyAuthCallback);
router.get("/test-connection", shopifyController.testConnection);
router.get("/orders", shopifyController.listShopifyOrders);
router.post("/orders/import", shopifyController.importOrdersDryRun);
router.post("/orders/:orderId/fulfillment", shopifyController.handleCreateFulfillment);
router.post(
  "/webhooks/orders-create",
  verifyShopifyWebhook,
  shopifyController.handleOrderCreatedWebhook
);
router.post(
  "/webhooks/orders-updated",
  verifyShopifyWebhook,
  shopifyController.handleOrderUpdatedWebhook
);
router.post(
  "/webhooks/orders-cancelled",
  verifyShopifyWebhook,
  shopifyController.handleOrderCancelledWebhook
);
router.post(
 "/webhooks/register",
 shopifyController.registerShopifyWebhook
);
module.exports = router;
