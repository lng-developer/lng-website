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
    try {
        let data = req.body;

        // Nếu chỉ gửi 1 object, bọc lại thành array để xử lý thống nhất
        if (!Array.isArray(data)) {
            data = [data];
        }

        // Tạo nhiều bản ghi (có thể chỉ là 1 phần tử)
        const users = await User.insertMany(data);

        res.status(201).json(users);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
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
