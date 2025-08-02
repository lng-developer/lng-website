const express = require('express');
const { login, refreshToken, changePassword } = require('../controllers/auth.controller');
const router = express.Router();

router.post('/login', login);
router.post('/refresh', refreshToken);
router.post('/change-password', changePassword);


module.exports = router;
