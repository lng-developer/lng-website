const express = require("express");
const router = express.Router();
const apoController = require("../controllers/APO.controller");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

router.post("/import-orders", upload.array("files"), apoController.importOrders);
router.post("/report-orders", upload.array("files"), apoController.reportOrders);
router.post("/ads-spend", upload.array("files"), apoController.adsSpend);

module.exports = router;

