// routes/configAuto.routes.js
const express = require("express");
const router = express.Router();
const configAutoController = require("../controllers/configAuto.controller");

// Chỉ 3 API cần thiết
router.get("/", configAutoController.getAllConfigAuto);           // Lấy danh sách
router.get("/:id", configAutoController.getConfigAutoById);       // Lấy theo ID  
router.put("/:id", configAutoController.updateConfigAuto);        // Cập nhật (bao gồm bật/tắt)

module.exports = router;