const express = require("express");
const { shopController } = require("../controllers");
const router = express.Router();

router.get("/", shopController.getAllShops);
router.post("/", shopController.createShop);
router.get("/:id", shopController.getShopById);
router.put("/:id", shopController.updateShop);
router.delete("/:id", shopController.deleteShop);
router.post("/add-user", shopController.addUserToShop);
router.post("/update-status", shopController.updateShopStatus);
router.get("/clients", shopController.getClients);
router.post("/ext/connect", shopController.connectExtension);

module.exports = router;
