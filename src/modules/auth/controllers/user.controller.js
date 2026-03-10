// src/modules/auth/controllers/user.controller.js
const userService = require('../services/user.service');

const getAllUsers = async (req, res) => {
    try {
        const users = await userService.getAllUsers();
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: "Get users failed", error: err.message });
    }
};

const getAllSeller = async (req, res) => {
    try {
        const users = await userService.getAllSeller();
        res.json(users);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Get users failed", error: err.message });
    }
};

const getAllDesigner = async (req, res) => {
    try {
        const users = await userService.getAllDesigner();
        res.json(users);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Get users failed", error: err.message });
    }
};

const getUserById = async (req, res) => {
    try {
        const user = await userService.getUserById(req.params.id);
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: "Get user failed", error: err.message });
    }
};

const createUser = async (req, res) => {
    try {
        const users = await userService.createUser(req.body);
        res.status(201).json(users);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

const updateUser = async (req, res) => {
    try {
        const user = await userService.updateUser(req.params.id, req.body);
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: "Update user failed", error: err.message });
    }
};

const deleteUser = async (req, res) => {
    try {
        await userService.deleteUser(req.params.id);
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ message: "Delete user failed", error: err.message });
    }
};

const getAllEmployeeCodes = async (req, res) => {
    try {
        const codes = await userService.getAllEmployeeCodes();
        res.json(codes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Get employee codes failed", error: err.message });
    }
};

const revokeAllUsersNow = async (req, res) => {
    try {
        const result = await userService.revokeAllUsersNow();
        return res.json(result);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Revoke all users failed", error: err.message });
    }
};

module.exports = {
    getAllUsers,
    getUserById,
    createUser,
    updateUser,
    deleteUser,
    getAllSeller,
    getAllDesigner,
    getAllEmployeeCodes,
    revokeAllUsersNow
};

