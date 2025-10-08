// middleware/auth.js
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const db = require('../models');
const User = db.user;

const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || req.headers.Authorization;
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Missing token' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // hỗ trợ legacy keys: userId | id | sub
        const rawUid = decoded.userId || decoded.id || decoded.sub;
        if (!rawUid || !mongoose.isValidObjectId(rawUid)) {
            return res.status(403).json({ message: 'Invalid user id in token' });
        }

        const userId = new mongoose.Types.ObjectId(rawUid);
        const user = await User.findById(userId).select('revokeAllBefore role_id');
        if (!user) return res.status(401).json({ message: 'User not found' });

        const tokenIatMs = (decoded.iat || 0) * 1000;
        const cutoffMs = new Date(user.revokeAllBefore || 0).getTime();
        if (tokenIatMs <= cutoffMs) {
            return res.status(403).json({ message: 'Token revoked' });
        }

        // role ưu tiên từ token (đã nhúng sẵn); fallback lấy từ DB nếu cần
        const roleFromToken = decoded.role;
        req.user = { id: userId.toString(), role: roleFromToken };

        next();
    } catch (err) {
        return res.status(403).json({ message: 'Invalid or expired token' });
    }
};

const authorizeRoles = (...allowedRoles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ message: 'Access denied: insufficient permissions' });
    }
    next();
};

module.exports = { authenticateToken, authorizeRoles };
