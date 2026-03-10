// src/modules/auth/services/account.service.js
const db = require('../../../models');
const Account = db.account;
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const getAllAccounts = async () => {
    return await Account.find().populate('user_id');
};

const getAccountById = async (id) => {
    const account = await Account.findById(id).populate('user_id');
    if (!account) {
        const error = new Error('Account not found');
        error.status = 404;
        throw error;
    }
    return account;
};

const createAccount = async (accountData) => {
    const { username, password, user_id } = accountData;

    if (!username || !password || !user_id) {
        const error = new Error('Missing required fields');
        error.status = 400;
        throw error;
    }

    const password_hash = await bcrypt.hash(password, 10);

    return await Account.create({
        username,
        password_hash,
        user_id
    });
};

const updateAccount = async (id, updateData) => {
    const updates = { ...updateData };

    if (updates.password) {
        updates.password_hash = await bcrypt.hash(updates.password, 10);
        delete updates.password;
    }

    const account = await Account.findByIdAndUpdate(id, updates, { new: true });
    if (!account) {
        const error = new Error('Account not found');
        error.status = 404;
        throw error;
    }

    return account;
};

const deleteAccount = async (id) => {
    const result = await Account.findByIdAndDelete(id);
    if (!result) {
        const error = new Error('Account not found');
        error.status = 404;
        throw error;
    }
};

const adminResetTempPassword = async (id) => {
    // tạo mật khẩu tạm đơn giản: 10 ký tự
    const tempPassword = crypto.randomBytes(6).toString('base64url'); // ~10 ký tự
    const password_hash = await bcrypt.hash(tempPassword, 10);

    const account = await Account.findByIdAndUpdate(
        id,
        {
            password_hash,
            refresh_token: null,           // đá hết phiên cũ
            revokeAllBefore: new Date(),   // nếu có trường này
            must_change_password: true,    // (tuỳ chọn) ép đổi khi login
        },
        { new: true }
    );

    if (!account) {
        const error = new Error('Account not found');
        error.status = 404;
        throw error;
    }

    // TRẢ VỀ mật khẩu tạm ngay để bạn gửi cho user (Zalo, chat nội bộ…)
    return {
        message: 'Đã reset mật khẩu tạm. Hãy yêu cầu user đăng nhập và đổi ngay.',
        username: account.username,
        temp_password: tempPassword
    };
};

module.exports = {
    getAllAccounts,
    getAccountById,
    createAccount,
    updateAccount,
    deleteAccount,
    adminResetTempPassword
};

