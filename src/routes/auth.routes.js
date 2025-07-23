const express = require('express');
const { login, refreshToken } = require('../controllers/auth.controller');
const router = express.Router();

router.post('/login', login);
router.post('/refresh', refreshToken);

module.exports = router;
