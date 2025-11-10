const db = require("../models");
const User = db.user;

const getAllUsers = async (req, res) => {
  const users = await User.find().populate("role_id");
  res.json(users);
};

const getAllSeller = async (req, res) => {
  try {
    // role_id seller
    const sellerRoleId = "6881d3fc9307f92c04dd8c8d";
    const adminRoleId = "6881d3f69307f92c04dd8c8b";

    const users = await User.find({
      role_id: { $in: [sellerRoleId, adminRoleId] },
    });

    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Get users failed", error: err.message });
  }
};

const getAllDesigner = async (req, res) => {
  try {
    const designRoleId = "6886ced93157601ba73ce832";
    const leadDesignRoleId = "68d4f11f3c366c734ea24284";
    const csRoleId = "688087528659a0e8cf260d46";
    const users = await User.find({
      role_id: { $in: [designRoleId, leadDesignRoleId, csRoleId] },
    });
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Get users failed", error: err.message });
  }
};

const getUserById = async (req, res) => {
  const user = await User.findById(req.params.id).populate("role_id");
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
  const user = await User.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  res.json(user);
};

const deleteUser = async (req, res) => {
  await User.findByIdAndDelete(req.params.id);
  res.status(204).send();
};

const getAllEmployeeCodes = async (req, res) => {
  try {
    // chỉ lấy field code (hoặc employeeCode) thôi
    const users = await User.find({}, "employee_id");
    const codes = users.map(u => u.employee_id).filter(Boolean); // loại bỏ null/undefined
    res.json(codes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Get employee codes failed", error: err.message });
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
  getAllEmployeeCodes
};
