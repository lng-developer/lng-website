// middleware/auth.js
const jwt = require('jsonwebtoken');
const db = require('../models');
const User = db.user;

const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'] || req.headers['Authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ message: 'Missing token' });

        const decoded = jwt.verify(token, process.env.JWT_SECRET); // ✅ verify thật
        if (!decoded?.userId) return res.status(403).json({ message: 'Invalid token payload' });

        const user = await User.findById(decoded.userId).select('revokeAllBefore');
        if (!user) return res.status(401).json({ message: 'User not found' });

        const tokenIatMs = (decoded.iat || 0) * 1000;
        const cutoffMs = new Date(user.revokeAllBefore || 0).getTime();
        if (tokenIatMs <= cutoffMs) return res.status(403).json({ message: 'Token revoked' });

        // đã nhúng role vào token → không cần query role nữa
        req.user = { id: decoded.userId, role: decoded.role };
        next();
    } catch {
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
