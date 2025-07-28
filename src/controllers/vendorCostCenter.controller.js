const db = require('../models');
const VendorCostCenter = db.vendorCostCenter;

// GET all vendor cost centers
const getAllVendorCostCenters = async (req, res) => {
    try {
        const list = await VendorCostCenter.find().populate('history.updated_by', 'name');
        res.json(list);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// GET single vendor cost center by ID
const getVendorCostCenterById = async (req, res) => {
    try {
        const item = await VendorCostCenter.findById(req.params.id).populate('history.updated_by', 'name');
        if (!item) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.json(item);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// POST create new vendor cost center
const createVendorCostCenter = async (req, res) => {
    try {
        const item = await VendorCostCenter.create(req.body);
        res.status(201).json(item);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// PUT update vendor cost center
const updateVendorCostCenter = async (req, res) => {
    try {
        const item = await VendorCostCenter.findByIdAndUpdate(
            req.params.id,
            { ...req.body, $push: { history: { updated_by: req.body.updated_by } } },
            { new: true }
        );
        if (!item) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.json(item);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// DELETE vendor cost center
const deleteVendorCostCenter = async (req, res) => {
    try {
        const item = await VendorCostCenter.findByIdAndDelete(req.params.id);
        if (!item) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// POST update status
const updateVendorCostCenterStatus = async (req, res) => {
    try {
        const { id, status } = req.body;
        if (!['Active', 'Inactive'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }
        const updated = await VendorCostCenter.findByIdAndUpdate(id, { status }, { new: true });
        if (!updated) return res.status(404).json({ message: 'Vendor Cost Center not found' });
        res.json(updated);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const getCostCentersByVendorProduct = async (req, res) => {
    try {
        const { vendorProductId } = req.params;
        const items = await VendorCostCenter.find({ vendor_product: vendorProductId })
            .populate('history.updated_by', 'name');
        res.json(items);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};


module.exports = {
    getAllVendorCostCenters,
    getVendorCostCenterById,
    createVendorCostCenter,
    updateVendorCostCenter,
    deleteVendorCostCenter,
    updateVendorCostCenterStatus,
    getCostCentersByVendorProduct
};
