const express = require("express");
const router = express.Router();
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");
const { reportController } = require("../controllers");

// ROUTES CRUD - ACCOUNT
router.get(
  "/",
  authenticateToken,
  authorizeRoles("Admin", "Seller"),
  reportController.getReportMatrix
);
router.post(
  "/import-file",
  authenticateToken,
  authorizeRoles("Admin"),
  upload.single("file"),
  reportController.importReportFromFile
);

module.exports = router;
