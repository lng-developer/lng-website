const express = require("express");
const router = express.Router();
const shopController = require("../controllers/shop.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");

// Extension routes
router.get("/ext/clients", shopController.getClients);
router.post("/ext/connect", shopController.connectExtension);

// Protected routes
router.use(authenticateToken);
router.get("/", shopController.getAllShops);
router.post("/", shopController.createShop);
router.get("/:id", shopController.getShopById);
router.put("/:id", shopController.updateShop);
router.delete("/:id", shopController.deleteShop);
router.post("/add-user", shopController.addUserToShop);
router.post("/update-status", shopController.updateShopStatus);

module.exports = router;

