// src/modules/auth/controllers/account.controller.js
const accountService = require('../services/account.service');

const getAllAccounts = async (req, res) => {
    try {
        const accounts = await accountService.getAllAccounts();
        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getAccountById = async (req, res) => {
    try {
        const account = await accountService.getAccountById(req.params.id);
        res.json(account);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ message: error.message });
        res.status(500).json({ error: error.message });
    }
};

const createAccount = async (req, res) => {
    try {
        const account = await accountService.createAccount(req.body);
        res.status(201).json(account);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ message: error.message });
        res.status(500).json({ error: error.message });
    }
};

const updateAccount = async (req, res) => {
    try {
        const account = await accountService.updateAccount(req.params.id, req.body);
        res.json(account);
    } catch (error) {
        if (error.status) return res.status(error.status).json({ message: error.message });
        res.status(500).json({ error: error.message });
    }
};

const deleteAccount = async (req, res) => {
    try {
        await accountService.deleteAccount(req.params.id);
        res.status(204).send();
    } catch (error) {
        if (error.status) return res.status(error.status).json({ message: error.message });
        res.status(500).json({ error: error.message });
    }
};

const adminResetTempPassword = async (req, res) => {
    try {
        const result = await accountService.adminResetTempPassword(req.params.id);
        return res.json(result);
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        return res.status(500).json({ error: err.message });
    }
};

module.exports = {
    getAllAccounts,
    getAccountById,
    createAccount,
    updateAccount,
    deleteAccount,
    adminResetTempPassword
};

