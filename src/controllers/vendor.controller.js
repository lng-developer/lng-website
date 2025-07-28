const db = require('../models');
const Vendor = db.vendor;

const getAllVendors = async (req, res) => {
    const vendors = await Vendor.find()
    res.json(vendors);
};

const getVendorById = async (req, res) => {
    const vendor = await Vendor.findById(req.params.id)
    res.json(vendor);
};

const createVendor = async (req, res) => {
    const vendor = await Vendor.create(req.body);
    res.status(201).json(vendor);
};

const updateVendor = async (req, res) => {
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(vendor);
};

const deleteVendor = async (req, res) => {
    await Vendor.findByIdAndDelete(req.params.id);
    res.status(204).send();
};

const updateVendorStatus = async (req, res) => {
    const { vendorId, status } = req.body;
    const allowed = ['Active', 'Inactive'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    const vendor = await Vendor.findByIdAndUpdate(vendorId, { status }, { new: true });
    res.json(vendor);
};

module.exports = {
    getAllVendors,
    getVendorById,
    createVendor,
    updateVendor,
    deleteVendor,
    updateVendorStatus
};