const db = require('../models');
const Account = db.account;
const bcrypt = require('bcrypt');


const getAllAccounts = async (req, res) => {
    try {
        const accounts = await Account.find().populate('user_id');
        res.json(accounts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


const getAccountById = async (req, res) => {
    try {
        const account = await Account.findById(req.params.id).populate('user_id');
        if (!account) return res.status(404).json({ message: 'Account not found' });
        res.json(account);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const createAccount = async (req, res) => {
    try {
        const { username, password, user_id } = req.body;

        if (!username || !password || !user_id) {
            return res.status(400).json({ message: 'Missing required fields' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const account = await Account.create({
            username,
            password_hash,
            user_id
        });

        res.status(201).json(account);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const updateAccount = async (req, res) => {
    try {
        const updates = { ...req.body };

        if (updates.password) {
            updates.password_hash = await bcrypt.hash(updates.password, 10);
            delete updates.password;
        }

        const account = await Account.findByIdAndUpdate(req.params.id, updates, { new: true });
        if (!account) return res.status(404).json({ message: 'Account not found' });

        res.json(account);

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const deleteAccount = async (req, res) => {
    try {
        const result = await Account.findByIdAndDelete(req.params.id);
        if (!result) return res.status(404).json({ message: 'Account not found' });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getAllAccounts,
    getAccountById,
    createAccount,
    updateAccount,
    deleteAccount
};
