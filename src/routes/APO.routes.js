const express = require("express");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const { APOController } = require("../controllers");

const router = express.Router();
router.post("/ext/ingest", upload.any(), APOController.importOrder);
module.exports = router;
