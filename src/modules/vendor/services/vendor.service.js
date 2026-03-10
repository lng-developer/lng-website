// src/modules/vendor/services/vendor.service.js
const db = require('../../../models');
const Vendor = db.vendor;

const getAllVendors = async () => {
    return await Vendor.find();
};

const getVendorById = async (id) => {
    return await Vendor.findById(id);
};

const createVendor = async (data) => {
    return await Vendor.create(data);
};

const updateVendor = async (id, data) => {
    return await Vendor.findByIdAndUpdate(id, data, { new: true });
};

const deleteVendor = async (id) => {
    await Vendor.findByIdAndDelete(id);
};

const updateVendorStatus = async (vendorId, status) => {
    const allowed = ['Active', 'Inactive'];
    if (!allowed.includes(status)) {
        const error = new Error('Invalid status');
        error.status = 400;
        throw error;
    }
    return await Vendor.findByIdAndUpdate(vendorId, { status }, { new: true });
};

module.exports = {
    getAllVendors,
    getVendorById,
    createVendor,
    updateVendor,
    deleteVendor,
    updateVendorStatus
};

