// src/routes/ext.routes.js
const express = require("express");
const router = express.Router();
const { extController } = require("../controllers");

// GET /api/ext/clients — trả danh sách clients (FE dùng để click chọn client)
router.get("/clients", extController.getClients);

// POST /api/ext/connect — extension ấn Connect → upsert ONLINE
router.post("/connect", extController.connectExtension);

// POST /api/ext/command — bắn lệnh tới 1 client
//  - IMPORT_ORDERS     -> payload: { status }
//  - IMPORT_ADS_SPEND  -> payload: { status, date }
router.post("/command", extController.requestExtension);

router.get("/online", extController.getClientOnline);

router.get("/logs", extController.getLogs);

router.get("/logs/summary", extController.getLogsSummary);

router.get("/logs/export", extController.exportLogs);

module.exports = router;
