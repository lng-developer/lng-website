const XLSX = require('xlsx');
const fs = require('fs');
const db = require('../models');
const VendorCostCenter = db.vendorCostCenter;
const VendorProduct = require('../models/vendorProduct.model'); // import nếu chưa


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

// GET cost centers by vendor product ID
const getCostCentersByVendorProduct = async (req, res) => {
    try {
        const { vendorProductId } = req.params;

        // Lấy thông tin sản phẩm
        const vendorProduct = await VendorProduct.findById(vendorProductId);
        if (!vendorProduct) {
            return res.status(404).json({ message: 'Vendor Product not found' });
        }

        // Lấy cost center liên quan
        const items = await VendorCostCenter.find({ vendor_product: vendorProductId })
            .populate('history.updated_by', 'name');

        // Trả về kèm tên sản phẩm
        res.json({
            vendor_product_name: vendorProduct.product_name || '',
            items
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// POST import cost centers from Excel
const importVendorCostCenterFromExcel = async (req, res) => {
    try {
        const file = req.file;
        const { vendor_product } = req.body;

        if (!file || !vendor_product) {
            return res.status(400).json({ message: 'Missing file, vendor_product, or user info' });
        }

        const workbook = XLSX.readFile(file.path);
        const sheet = workbook.Sheets['Dreamship'];
        if (!sheet) return res.status(400).json({ message: 'Sheet Dreamship not found' });

        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (jsonData.length < 2) {
            return res.status(400).json({ message: 'Excel sheet is empty or missing data' });
        }

        const rows = jsonData.slice(2);
        const inserted = [];

        for (const row of rows) {
            const [
                , // product_name
                product_code,
                vendor_size,
                vendor_color,
                , // variant
                status,
                base_cost,
                domestic_economy,
                domestic_additional,
                , // domestic_express
                intl_economy,
                intl_additional
            ] = row;

            if (!vendor_size || !vendor_color) continue;

            const doc = new VendorCostCenter({
                vendor_product,
                vendor_size: vendor_size.toString(),
                vendor_color: vendor_color.toString(),
                standard_size: vendor_size.toString(),
                standard_color: vendor_color.toString(),
                sku: product_code?.toString() || '',
                base_cost: Number(base_cost) || 0,
                dosmetic: {
                    economy: Number(domestic_economy) || 0,
                    additional: Number(domestic_additional) || 0
                },
                international: {
                    economy: Number(intl_economy) || 0,
                    additional: Number(intl_additional) || 0
                },
                product_type_design: '',
                status: ['Active', 'Inactive'].includes((status || '').trim()) ? status.trim() : 'Active'
            });

            await doc.save();
            inserted.push(doc);
        }

        // Xóa file sau khi dùng
        fs.unlink(file.path, () => { });

        res.status(201).json({
            message: `Imported ${inserted.length} records successfully`,
            data: inserted
        });
    } catch (error) {
        console.error('Import Error:', error);
        res.status(500).json({ message: 'Failed to import Excel data', error: error.message });
    }
};

module.exports = {
    getAllVendorCostCenters,
    getVendorCostCenterById,
    createVendorCostCenter,
    updateVendorCostCenter,
    deleteVendorCostCenter,
    updateVendorCostCenterStatus,
    getCostCentersByVendorProduct,
    importVendorCostCenterFromExcel
};
