const db = require('../models');
const User = db.user;


const getAllUsers = async (req, res) => {
    const users = await User.find().populate('role_id');
    res.json(users);
};

const getUserById = async (req, res) => {
    const user = await User.findById(req.params.id).populate('role_id');
    res.json(user);
};

const createUser = async (req, res) => {
    const user = await User.create(req.body);
    res.status(201).json(user);
};

const updateUser = async (req, res) => {
    const user = await User.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(user);
};

const deleteUser = async (req, res) => {
    await User.findByIdAndDelete(req.params.id);
    res.status(204).send();
};

module.exports = { getAllUsers, getUserById, createUser, updateUser, deleteUser };
