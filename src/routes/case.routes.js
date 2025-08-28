const express = require('express');
const { caseController } = require('../controllers');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');
router.get('/', authenticateToken, caseController.getAllCases);
router.get('/:id', authenticateToken, caseController.getCaseById);
router.post('/', authenticateToken, caseController.createCase);
router.put('/:id', authenticateToken, caseController.updateCase);
router.delete('/:id', authenticateToken, caseController.deleteCase);

module.exports = router;
