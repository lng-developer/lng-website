const express = require("express");
const controller = require("../controllers/orderLifecycle.controller");
const { authenticateToken, authorizeRoles } = require("../middlewares/auth.middleware");

const router = express.Router();

router.get("/events", authenticateToken, authorizeRoles("Admin"), controller.getEvents);
router.get("/summary", authenticateToken, authorizeRoles("Admin"), controller.getSummary);

module.exports = router;
