const express = require('express');
const router = express.Router();
const accountController = require('../controllers/account.controller');
const { authenticateToken, authorizeRoles } = require('../../../middleware/auth.middleware');

// ROUTES CRUD - ACCOUNT
router.get('/', authenticateToken, authorizeRoles('Admin'), accountController.getAllAccounts);

router.get('/:id', authenticateToken, authorizeRoles('Admin'), accountController.getAccountById);

router.post('/', authenticateToken, authorizeRoles('Admin'), accountController.createAccount);

router.put('/:id', authenticateToken, authorizeRoles('Admin'), accountController.updateAccount);

router.delete('/:id', authenticateToken, authorizeRoles('Admin'), accountController.deleteAccount);

router.post('/:id/password/reset-temp', accountController.adminResetTempPassword);

module.exports = router;

