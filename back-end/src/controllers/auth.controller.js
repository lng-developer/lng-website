const db = require('../models');
const Account = db.account;
const User = db.user;

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const login = async (req, res) => {
    try {
        const { username, password } = req.body;

        const account = await Account.findOne({ username }).populate('user_id');
        if (!account) return res.status(400).json({ message: 'Invalid username or password' });

        const validPassword = await bcrypt.compare(password, account.password_hash);
        if (!validPassword) return res.status(400).json({ message: 'Invalid username or password' });

        const user = await User.findById(account.user_id).populate('role_id');

        const payload = { userId: user._id, role: user.role_id.name };
        const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });

        const refreshToken = crypto.randomBytes(64).toString('hex');
        account.refresh_token = refreshToken;
        await account.save();

        res.json({
            message: 'Login successful',
            accessToken,
            refreshToken,
            user: {
                id: user._id,
                full_name: user.full_name,
                email: user.email,
                role: user.role_id.name
            }
        });

    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;

        const account = await Account.findOne({ refresh_token: refreshToken }).populate('user_id');
        if (!account) return res.status(403).json({ message: 'Invalid refresh token' });

        const user = await User.findById(account.user_id).populate('role_id');

        const payload = { userId: user._id, role: user.role_id.name };
        const newAccessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '15m' });

        res.json({ accessToken: newAccessToken });

    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

module.exports = { login, refreshToken };
