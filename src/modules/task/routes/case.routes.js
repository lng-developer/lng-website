const express = require("express");
const router = express.Router();
const caseController = require("../controllers/case.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");

router.use(authenticateToken);
router.get("/", caseController.getAllCases);
router.get("/:id", caseController.getCaseById);
router.post("/", caseController.createCase);
router.put("/:id", caseController.updateCase);
router.delete("/:id", caseController.deleteCase);

module.exports = router;

