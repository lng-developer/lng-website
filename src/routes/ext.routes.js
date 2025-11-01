// src/routes/ext.routes.js
const express = require("express");
const router = express.Router();
const { extController } = require("../controllers");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

router.post("/command", extController.requestExtension);

router.get("/online", extController.getClientOnline);

module.exports = router;
