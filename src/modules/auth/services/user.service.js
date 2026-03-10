// src/modules/auth/services/user.service.js
const db = require("../../../models");
const User = db.user;

const getAllUsers = async () => {
    return await User.find().populate("role_id");
};

const getAllSeller = async () => {
    // role_id seller
    const sellerRoleId = "6881d3fc9307f92c04dd8c8d";
    const adminRoleId = "6881d3f69307f92c04dd8c8b";

    return await User.find({
        role_id: { $in: [sellerRoleId, adminRoleId] },
    });
};

const getAllDesigner = async () => {
    const designRoleId = "6886ced93157601ba73ce832";
    const leadDesignRoleId = "68d4f11f3c366c734ea24284";
    const csRoleId = "688087528659a0e8cf260d46";

    return await User.find({
        role_id: { $in: [designRoleId, leadDesignRoleId, csRoleId] },
    });
};

const getUserById = async (id) => {
    return await User.findById(id).populate("role_id");
};

const createUser = async (userData) => {
    let data = userData;
    if (!Array.isArray(data)) {
        data = [data];
    }
    return await User.insertMany(data);
};

const updateUser = async (id, updateData) => {
    return await User.findByIdAndUpdate(id, updateData, {
        new: true,
    });
};

const deleteUser = async (id) => {
    await User.findByIdAndDelete(id);
};

const getAllEmployeeCodes = async () => {
    const users = await User.find({}, "employee_id");
    return users.map(u => u.employee_id).filter(Boolean);
};

const revokeAllUsersNow = async () => {
    const now = new Date();
    const result = await User.updateMany(
        {},
        { $set: { revokeAllBefore: now } }
    );

    return {
        message: "Revoke all users success",
        revokeAllBefore: now,
        matched: result.matchedCount ?? result.n,
        modified: result.modifiedCount ?? result.nModified,
    };
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

