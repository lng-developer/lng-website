const express = require("express");
const shopifyController = require("../controllers/shopify.controller");

const router = express.Router();

router.get("/test-connection", shopifyController.testConnection);
router.post("/orders/import", shopifyController.importOrdersDryRun);

module.exports = router;
