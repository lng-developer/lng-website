const XLSX = require('xlsx');
const fs = require('fs');
const db = require('../models');
const VendorCostCenter = db.vendorCostCenter;
const VendorProduct = require('../models/vendorProduct.model'); // import nếu chưa


// GET all vendor cost centers
const getAllVendorCostCenters = async (req, res) => {
    try {
        const {
            vendor_product,
            status,
            vendor_size,
            vendor_color,
            sku,
            search,         // search keyword for sku/size/color
            page = 1,
            perPage = 10
        } = req.query;

        const filter = {};

        if (vendor_product) {
            filter.vendor_product = vendor_product;
        }

        if (status) {
            filter.status = status;
        }

        if (vendor_size) {
            filter.vendor_size = vendor_size;
        }

        if (vendor_color) {
            filter.vendor_color = vendor_color;
        }

        if (sku) {
            filter.sku = sku;
        }

        // Search keyword
        if (search) {
            const regex = new RegExp(search, 'i');
            filter.$or = [
                { sku: regex },
                { vendor_size: regex },
                { vendor_color: regex }
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(perPage);
        const limit = parseInt(perPage);

        const [total, items] = await Promise.all([
            VendorCostCenter.countDocuments(filter),
            VendorCostCenter.find(filter)
                .populate('history.updated_by', 'name')
                .sort({ created_at: -1 }) // optional
                .skip(skip)
                .limit(limit)
        ]);

        res.json({
            total,
            page: parseInt(page),
            perPage: parseInt(perPage),
            data: items
        });
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

const importVendorCostCenterFromExcel = async (req, res) => {
    try {
        const file = req.file;
        const { vendor_product } = req.body;

        if (!file || !vendor_product) {
            return res.status(400).json({ message: 'Missing file or vendor_product' });
        }

        const workbook = XLSX.readFile(file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        if (jsonData.length < 2) {
            return res.status(400).json({ message: 'Excel sheet is empty or missing data' });
        }

        const rows = jsonData.slice(2); // bỏ dòng tiêu đề

        const inserted = [];

        for (const row of rows) {
            if (!row || row.length < 7) {
                continue;
            }

            const product_code = row[1]?.toString() || '';
            const vendor_size = row[2]?.toString() || '';
            const vendor_color = row[3]?.toString() || '';
            const status = row[5]?.toString().trim().toLowerCase() || 'active';
            const base_cost = Number(row[6]) || 0;
            const domestic_economy = Number(row[7]) || 0;
            const domestic_additional = Number(row[8]) || 0;
            const intl_economy = Number(row[9]) || 0;
            const intl_additional = Number(row[10]) || 0;
            const embroidery_cost = Number(row[11]) || 0;
            const two_sided_print_cost = Number(row[12]) || 0;
            const two_position_print_cost = Number(row[13]) || 0;

            const doc = new VendorCostCenter({
                vendor_product,
                vendor_size,
                vendor_color,
                standard_size: vendor_size,
                standard_color: vendor_color,
                sku: product_code,
                base_cost,
                dosmetic: {
                    economy: domestic_economy,
                    additional: domestic_additional
                },
                international: {
                    economy: intl_economy,
                    additional: intl_additional
                },
                // ✅ NEW: Additional costs
                additional_costs: {
                    embroidery: embroidery_cost,
                    two_sided_print: two_sided_print_cost,
                    two_position_print: two_position_print_cost
                },
                product_type_design: '',
                status: ['active', 'inactive'].includes(status) ? status.charAt(0).toUpperCase() + status.slice(1) : 'Active'
            });

            await doc.save();
            inserted.push(doc);
        }

        fs.unlink(file.path, () => { });

        res.status(201).json({
            message: `Imported ${inserted.length} records successfully with additional costs`,
            data: inserted
        });
    } catch (error) {
        console.error('❌ Import Error:', error);
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
