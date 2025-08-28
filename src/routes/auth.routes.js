const express = require('express');
const { login, refreshToken, changePassword } = require('../controllers/auth.controller');
const router = express.Router();
const { authenticateToken } = require('../middlewares/auth.middleware');

router.post('/login', authenticateToken, login);
router.post('/refresh', authenticateToken, refreshToken);
router.post('/change-password', authenticateToken, changePassword);


module.exports = router;
