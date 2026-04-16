const AutoConfig = require("../models/autoConfig.model");

// Lấy tất cả
const getAll = async (req, res) => {
  try {
    const configs = await AutoConfig.find().sort({ created_at: -1 });
    res.json({ success: true, data: configs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// Thêm mới
const create = async (req, res) => {
  try {
    const { type, status, time, shopId, shopName, describe } = req.body;
    const config = await AutoConfig.create({ type, status, time, shopId, shopName, describe });
    res.status(201).json({ success: true, data: config });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Cập nhật
const update = async (req, res) => {
  try {
    const config = await AutoConfig.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!config) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// Xóa
const remove = async (req, res) => {
  try {
    const config = await AutoConfig.findByIdAndDelete(req.params.id);
    if (!config) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getAll, create, update, remove };
