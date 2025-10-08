// controllers/auth.controller.js
const db = require('../models');
const Account = db.account;
const User = db.user;
const Role = db.role;

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// helper: tạo access token (iat tự sinh)
function signAccessToken(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });
}

const login = async (req, res) => {
    try {
        const { username, password } = req.body;

        const account = await Account.findOne({ username }).populate('user_id');
        if (!account) return res.status(400).json({ message: 'Invalid username or password' });

        const validPassword = await bcrypt.compare(password, account.password_hash || '');
        if (!validPassword) return res.status(400).json({ message: 'Invalid username or password' });

        const user = await User.findById(account.user_id).populate('role_id', 'name');
        if (!user) return res.status(404).json({ message: 'User not found' });

        // nhúng role name vào token để tránh populate mỗi request
        const payload = { userId: user._id.toString(), role: user.role_id?.name || 'User' };
        const accessToken = signAccessToken(payload);

        // rotate refresh token
        const newRefreshToken = crypto.randomBytes(64).toString('hex');
        account.refresh_token = newRefreshToken;
        account.last_login = new Date();            // rất quan trọng cho logic revoke vs refresh
        await account.save();

        return res.json({
            message: 'Login successful',
            accessToken,
            refreshToken: newRefreshToken,
            user: {
                id: user._id,
                full_name: user.full_name,
                email: user.email,
                role: user.role_id?.name || 'User'
            }
        });
    } catch (error) {
        console.error('login error', error);
        return res.status(500).json({ error: { message: error.message } });
    }
};

const refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ message: 'Missing refresh token' });

        // tìm account theo refresh token hiện tại
        const account = await Account.findOne({ refresh_token: refreshToken }).populate('user_id');
        if (!account) return res.status(403).json({ message: 'Invalid refresh token' });

        const user = await User.findById(account.user_id).populate('role_id', 'name');
        if (!user) return res.status(404).json({ message: 'User not found' });

        // 🚫 CHỐT CHẶT: nếu admin đã "logout all" (set revokeAllBefore = T)
        // và T lớn hơn/thời điểm sau lần login gần nhất → KHÔNG cho refresh
        const lastLoginMs = account.last_login ? new Date(account.last_login).getTime() : 0;
        const revokeCutoffMs = user.revokeAllBefore ? new Date(user.revokeAllBefore).getTime() : 0;

        if (revokeCutoffMs && lastLoginMs && lastLoginMs <= revokeCutoffMs) {
            return res.status(403).json({ message: 'Session revoked. Please login again.' });
        }

        // hợp lệ → cấp access token mới
        const payload = { userId: user._id.toString(), role: user.role_id?.name || 'User' };
        const newAccessToken = signAccessToken(payload);

        // (tuỳ chọn) rotate refresh token mỗi lần refresh để an toàn hơn
        // const rotated = crypto.randomBytes(64).toString('hex');
        // account.refresh_token = rotated;
        // await account.save();
        // return res.json({ accessToken: newAccessToken, refreshToken: rotated });

        return res.json({ accessToken: newAccessToken });
    } catch (error) {
        console.error('refreshToken error', error);
        return res.status(500).json({ error: { message: error.message } });
    }
};

const changePassword = async (req, res) => {
    try {
        const { username, oldPassword, newPassword } = req.body;
        if (!username || !oldPassword || !newPassword) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const account = await Account.findOne({ username });
        if (!account) return res.status(404).json({ message: 'Account not found' });

        const isMatch = await bcrypt.compare(oldPassword, account.password_hash || '');
        if (!isMatch) return res.status(400).json({ message: 'Old password is incorrect' });

        const salt = await bcrypt.genSalt(10);
        const hashedNewPassword = await bcrypt.hash(newPassword, salt);

        account.password_hash = hashedNewPassword;

        // 🔐 Tăng an toàn: khi đổi password → revoke session của user này
        const user = await User.findById(account.user_id);
        if (user) {
            user.revokeAllBefore = new Date();
            await user.save();
        }

        // Xoá refresh token hiện tại của account này
        account.refresh_token = null;
        await account.save();

        return res.json({ message: 'Password updated successfully. Please login again.' });
    } catch (error) {
        console.error('changePassword error', error);
        return res.status(500).json({ error: { message: error.message } });
    }
};

module.exports = { login, refreshToken, changePassword };
