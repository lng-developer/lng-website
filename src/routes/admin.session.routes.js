// routes/admin.session.routes.js
const express = require('express');
const router = express.Router();
const db = require('../models');
const User = db.user;
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');

router.post('/invalidate-all', authenticateToken, authorizeRoles('Admin'), async (_req, res) => {
    try {
        await User.updateMany({}, { $set: { revokeAllBefore: new Date() } });
        res.json({ message: 'All sessions invalidated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Failed to invalidate sessions' });
    }
});

module.exports = router;
