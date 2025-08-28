const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');
const { accountController } = require('../controllers');

// ROUTES CRUD - ACCOUNT
router.get('/', authenticateToken, authorizeRoles('Admin'), accountController.getAllAccounts);

router.get('/:id', authenticateToken, authorizeRoles('Admin'), accountController.getAccountById);

router.post('/', authenticateToken, authorizeRoles('Admin'), accountController.createAccount);

router.put('/:id', authenticateToken, authorizeRoles('Admin'), accountController.updateAccount);

router.delete('/:id', authenticateToken, authorizeRoles('Admin'), accountController.deleteAccount);

module.exports = router;
