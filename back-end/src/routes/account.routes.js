const express = require('express');
const router = express.Router();

const { accountController } = require('../controllers');

// ROUTES CRUD - ACCOUNT
router.get('/', accountController.getAllAccounts);

router.get('/:id', accountController.getAccountById);

router.post('/', accountController.createAccount);

router.put('/:id', accountController.updateAccount);

router.delete('/:id', accountController.deleteAccount);

module.exports = router;
