// src/modules/auth/services/auth.service.js
const db = require('../../../models');
const Account = db.account;
const User = db.user;
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

function signAccessToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET);
}

const login = async (username, password) => {
    const account = await Account.findOne({ username }).populate('user_id');
    if (!account) {
        const error = new Error('Invalid username or password');
        error.status = 400;
        throw error;
    }

    const validPassword = await bcrypt.compare(password, account.password_hash || '');
    if (!validPassword) {
        const error = new Error('Invalid username or password');
        error.status = 400;
        throw error;
    }

    const user = await User.findById(account.user_id).populate('role_id', 'name');
    if (!user) {
        const error = new Error('User not found');
        error.status = 404;
        throw error;
    }

    const payload = { userId: user._id.toString(), role: user.role_id?.name || 'User' };
    const accessToken = signAccessToken(payload);

    const newRefreshToken = crypto.randomBytes(64).toString('hex');
    account.refresh_token = newRefreshToken;
    account.last_login = new Date();
    await account.save();

    return {
        message: 'Login successful',
        accessToken,
        refreshToken: newRefreshToken,
        user: {
            id: user._id,
            full_name: user.full_name,
            email: user.email,
            role: user.role_id?.name || 'User'
        }
    };
};

const refreshToken = async (token) => {
    if (!token) {
        const error = new Error('Missing refresh token');
        error.status = 400;
        throw error;
    }

    const account = await Account.findOne({ refresh_token: token }).populate('user_id');
    if (!account) {
        const error = new Error('Invalid refresh token');
        error.status = 403;
        throw error;
    }

    const user = await User.findById(account.user_id).populate('role_id', 'name');
    if (!user) {
        const error = new Error('User not found');
        error.status = 404;
        throw error;
    }

    const lastLoginMs = account.last_login ? new Date(account.last_login).getTime() : 0;
    const revokeCutoffMs = user.revokeAllBefore ? new Date(user.revokeAllBefore).getTime() : 0;

    if (revokeCutoffMs && lastLoginMs && lastLoginMs <= revokeCutoffMs) {
        const error = new Error('Session revoked. Please login again.');
        error.status = 403;
        throw error;
    }

    const payload = { userId: user._id.toString(), role: user.role_id?.name || 'User' };
    const newAccessToken = signAccessToken(payload);

    return { accessToken: newAccessToken };
};

const changePassword = async (username, oldPassword, newPassword) => {
    if (!username || !oldPassword || !newPassword) {
        const error = new Error('Missing required fields');
        error.status = 400;
        throw error;
    }

    const account = await Account.findOne({ username });
    if (!account) {
        const error = new Error('Account not found');
        error.status = 404;
        throw error;
    }

    const isMatch = await bcrypt.compare(oldPassword, account.password_hash || '');
    if (!isMatch) {
        const error = new Error('Old password is incorrect');
        error.status = 400;
        throw error;
    }

    const salt = await bcrypt.genSalt(10);
    const hashedNewPassword = await bcrypt.hash(newPassword, salt);

    account.password_hash = hashedNewPassword;

    const user = await User.findById(account.user_id);
    if (user) {
        user.revokeAllBefore = new Date();
        await user.save();
    }

    account.refresh_token = null;
    await account.save();

    return { message: 'Password updated successfully. Please login again.' };
};

module.exports = { login, refreshToken, changePassword };

