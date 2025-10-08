// middleware/auth.js
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const db = require('../models');
const User = db.user;

const DEBUG_AUTH = process.env.DEBUG_AUTH === '1';

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Missing token' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Hỗ trợ nhiều kiểu key cũ
    const rawUid = decoded.userId || decoded.id || decoded.sub;
    if (DEBUG_AUTH) {
      console.log('[auth] decoded=', decoded);
      console.log('[auth] rawUid=', rawUid, 'isValidObjectId=', mongoose.isValidObjectId(rawUid));
    }

    if (!rawUid || !mongoose.isValidObjectId(rawUid)) {
      return res.status(403).json({ message: 'Invalid user id in token' });
    }

    const userId = new mongoose.Types.ObjectId(rawUid);
    const user = await User.findById(userId).select('revokeAllBefore role_id');
    if (!user) {
      if (DEBUG_AUTH) console.log('[auth] user not found by id:', rawUid);
      return res.status(401).json({ message: 'User not found' });
    }

    // Check revoke
    const tokenIatMs = (decoded.iat || 0) * 1000;
    const cutoffMs = new Date(user.revokeAllBefore || 0).getTime();
    if (tokenIatMs <= cutoffMs) {
      if (DEBUG_AUTH) console.log('[auth] token revoked: iat', tokenIatMs, '<= cutoff', cutoffMs);
      return res.status(403).json({ message: 'Token revoked' });
    }

    // Nhúng đủ cho code cũ và mới
    const roleFromToken = decoded.role;
    req.user = {
      id: userId.toString(),
      userId: userId.toString(), // 👈 để API cũ không vỡ
      role: roleFromToken,
    };

    return next();
  } catch (err) {
    if (DEBUG_AUTH) console.error('[auth] error', err);
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
