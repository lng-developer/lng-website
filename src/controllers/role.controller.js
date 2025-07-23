const db = require('../models');
const Role = db.role;

const getAllRoles = async (req, res) => {
    const roles = await Role.find();
    res.json(roles);
};

const getRoleById = async (req, res) => {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found' });
    res.json(role);
};

const createRole = async (req, res) => {
    try {
        const role = await Role.create(req.body);
        res.status(201).json(role);
    } catch (error) {
        res.status(500).json({ error: { message: error.message } });
    }
};

const updateRole = async (req, res) => {
    const role = await Role.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(role);
};

const deleteRole = async (req, res) => {
    await Role.findByIdAndDelete(req.params.id);
    res.status(204).send();
};

module.exports = { getAllRoles, getRoleById, createRole, updateRole, deleteRole };
