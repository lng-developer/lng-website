const express = require('express');
const { caseController } = require('../controllers');
const router = express.Router();

router.get('/', caseController.getAllCases);
router.get('/:id', caseController.getCaseById);
router.post('/', caseController.createCase);
router.put('/:id', caseController.updateCase);
router.delete('/:id', caseController.deleteCase);

module.exports = router;
