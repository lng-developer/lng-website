const jwt = require('jsonwebtoken');
const db = require('../models');
const User = db.user;
const Role = db.role;

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    console.log(token);

    if (!token) return res.status(401).json({ message: 'Missing token' });

    // jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    //     if (err) return res.status(403).json({ message: 'Invalid or expired token' });
    //     req.user = decoded;   // { userId, role }
    //     next();
    // });
    try {
        const decoded = jwt.decode(token); // Không kiểm tra expired
        if (!decoded) return res.status(403).json({ message: 'Invalid token' });
        req.user = decoded;   // { userId, role }
        next();
    } catch (err) {
        return res.status(403).json({ message: 'Invalid token' });
    }
};

const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

        const userRole = req.user.role;
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({ message: 'Access denied: insufficient permissions' });
        }
        next();
    };
};

module.exports = { authenticateToken, authorizeRoles };
