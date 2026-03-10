const express = require("express");
const router = express.Router();
const etsyOrderController = require("../controllers/etsyOrder.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

router.use(authenticateToken);

router.post("/import", upload.array("files"), etsyOrderController.importOrders);
router.get("/", etsyOrderController.getListOrders);
router.delete("/:id", etsyOrderController.deleteOrder);

module.exports = router;

