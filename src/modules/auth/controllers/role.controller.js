// src/modules/auth/controllers/role.controller.js
const roleService = require('../services/role.service');

const getAllRoles = async (req, res) => {
    try {
        const roles = await roleService.getAllRoles();
        res.json(roles);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const getRoleById = async (req, res) => {
    try {
        const role = await roleService.getRoleById(req.params.id);
        res.json(role);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        res.status(500).json({ error: { message: error.message } });
    }
};

const createRole = async (req, res) => {
    try {
        const role = await roleService.createRole(req.body);
        res.status(201).json(role);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const updateRole = async (req, res) => {
    try {
        const role = await roleService.updateRole(req.params.id, req.body);
        res.json(role);
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        res.status(500).json({ error: { message: error.message } });
    }
};

const deleteRole = async (req, res) => {
    try {
        await roleService.deleteRole(req.params.id);
        res.status(204).send();
    } catch (error) {
        if (error.status) {
            return res.status(error.status).json({ message: error.message });
        }
        res.status(500).json({ error: { message: error.message } });
    }
};

module.exports = { getAllRoles, getRoleById, createRole, updateRole, deleteRole };

