// src/modules/auth/controllers/auth.controller.js
const authService = require('../services/auth.service');

const login = async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await authService.login(username, password);
        return res.json(result);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('login error', error);
        return res.status(500).json({ error: { message: error.message } });
    }
};

const refreshToken = async (req, res) => {
    try {
        const { refreshToken: token } = req.body;
        const result = await authService.refreshToken(token);
        return res.json(result);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('refreshToken error', error);
        return res.status(500).json({ error: { message: error.message } });
    }
};

const changePassword = async (req, res) => {
    try {
        const { username, oldPassword, newPassword } = req.body;
        const result = await authService.changePassword(username, oldPassword, newPassword);
        return res.json(result);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        console.error('changePassword error', error);
        return res.status(500).json({ error: { message: error.message } });
    }
};

module.exports = { login, refreshToken, changePassword };

