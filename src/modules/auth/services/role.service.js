// src/modules/auth/services/role.service.js
const db = require('../../../models');
const Role = db.role;

const getAllRoles = async () => {
    return await Role.find();
};

const getRoleById = async (id) => {
    const role = await Role.findById(id);
    if (!role) {
        const error = new Error('Role not found');
        error.status = 404;
        throw error;
    }
    return role;
};

const createRole = async (roleData) => {
    return await Role.create(roleData);
};

const updateRole = async (id, updateData) => {
    const role = await Role.findByIdAndUpdate(id, updateData, { new: true });
    if (!role) {
        const error = new Error('Role not found');
        error.status = 404;
        throw error;
    }
    return role;
};

const deleteRole = async (id) => {
    const role = await Role.findByIdAndDelete(id);
    if (!role) {
        const error = new Error('Role not found');
        error.status = 404;
        throw error;
    }
    return role;
};

module.exports = { getAllRoles, getRoleById, createRole, updateRole, deleteRole };

