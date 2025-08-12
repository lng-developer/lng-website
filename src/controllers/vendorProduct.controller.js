const db = require('../models');
const VendorProduct = db.vendorProduct;
const XLSX = require('xlsx');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' }); // Tạm thời lưu file Excel

const importVendorProductFromExcel = async (req, res) => {
    try {
        const vendorId = req.body.vendor_id;
        if (!vendorId) {
            return res.status(400).json({ message: 'Missing vendor_id in query' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const filePath = path.resolve(req.file.path);
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        if (rawData.length === 0) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ message: 'Excel file is empty' });
        }

        const dataToInsert = rawData.map(row => ({
            vendor_id: vendorId,
            image: row.image || '',
            product_id: row.product_id || '',
            product_name: row.product_name || '',
            status: row.status || 'Active',
            product_type_design: row.product_type_design || ''
        }));

        const inserted = await VendorProduct.insertMany(dataToInsert);

        fs.unlinkSync(filePath); // Xoá file sau khi xử lý
        res.status(201).json({ message: 'Import successful', insertedCount: inserted.length });
    } catch (error) {
        res.status(500).json({ message: 'Failed to import vendor products', error: error.message });
    }
};

const getAllVendorProducts = async (req, res) => {
    try {
        const {
            vendor_id,
            status,
            product_type_design,
            search,
            vendor_name,    // filter theo tên vendor
            page = 1,
            perPage = 10
        } = req.query;

        const pageNum = parseInt(page, 10) || 1;
        const limit = parseInt(perPage, 10) || 10;
        const skip = (pageNum - 1) * limit;

        // Match chính trên product
        const matchStage = {};

        // filter theo vendor_id nếu hợp lệ
        if (vendor_id) {
            if (!mongoose.isValidObjectId(vendor_id)) {
                return res.status(400).json({ message: 'Invalid vendor_id' });
            }
            matchStage.vendor_id = new mongoose.Types.ObjectId(vendor_id);
        }

        if (status) matchStage.status = status;
        if (product_type_design) matchStage.product_type_design = product_type_design;

        if (search) {
            matchStage.product_name = { $regex: search, $options: 'i' };
        }

        // Pipeline tổng quát
        const aggregatePipeline = [
            { $match: matchStage },
            {
                $lookup: {
                    from: 'vendors',          // tên collection
                    localField: 'vendor_id',
                    foreignField: '_id',
                    as: 'vendor'
                }
            },
            // Không làm rớt record thiếu vendor (nếu có)
            { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } }
        ];

        // Filter theo vendor_name (nếu cần)
        if (vendor_name) {
            aggregatePipeline.push({
                $match: {
                    'vendor.name': { $regex: vendor_name, $options: 'i' }
                }
            });
        }

        // Project để chuẩn hóa output (giữ cả vendor_id lẫn vendor object)
        aggregatePipeline.push({
            $project: {
                image: 1,
                product_id: 1,
                product_name: 1,
                status: 1,
                product_type_design: 1,
                created_at: 1,
                vendor_id: 1,
                vendor: {
                    _id: '$vendor._id',
                    name: '$vendor.name',
                    status: '$vendor.status',
                    fulfillment_type: '$vendor.fulfillment_type'
                }
            }
        });

        // Pipeline đếm tổng sau khi áp mọi filter
        const countPipeline = [...aggregatePipeline, { $count: 'total' }];

        // Phân trang + sort
        aggregatePipeline.push({ $sort: { created_at: -1 } });
        aggregatePipeline.push({ $skip: skip });
        aggregatePipeline.push({ $limit: limit });

        const [countResult, items] = await Promise.all([
            VendorProduct.aggregate(countPipeline),
            VendorProduct.aggregate(aggregatePipeline)
        ]);

        const total = countResult[0]?.total || 0;

        return res.json({
            total,
            page: pageNum,
            perPage: limit,
            data: items
        });
    } catch (error) {
        return res.status(500).json({ message: 'Failed to fetch vendor products', error: error.message });
    }
};

const getVendorProductById = async (req, res) => {
    const item = await VendorProduct.findById(req.params.id);
    res.json(item);
};

const createVendorProduct = async (req, res) => {
    try {
        const data = req.body;

        if (Array.isArray(data)) {
            if (data.length === 0) {
                return res.status(400).json({ message: 'Empty array provided' });
            }

            const items = await VendorProduct.insertMany(data);
            return res.status(201).json(items);
        }

        // Nếu là object → tạo 1 bản ghi
        const item = await VendorProduct.create(data);
        return res.status(201).json(item);

    } catch (error) {
        res.status(500).json({ message: 'Failed to create vendor product(s)', error: error.message });
    }
};

const updateVendorProduct = async (req, res) => {
    const item = await VendorProduct.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(item);
};

const deleteVendorProduct = async (req, res) => {
    await VendorProduct.findByIdAndDelete(req.params.id);
    res.status(204).send();
};

const getVendorProductsByVendorId = async (req, res) => {
    try {
        const { vendorId } = req.params;
        if (!vendorId) {
            return res.status(400).json({ message: 'Missing vendorId in params' });
        }

        const products = await VendorProduct.find({ vendor_id: vendorId })
            .populate({
                path: 'vendor_id',
                select: 'name status fulfillment_type'
            })
            .sort({ created_at: -1 });

        // Chuẩn hóa: thêm field vendor
        const data = products.map(p => {
            const obj = p.toObject();
            obj.vendor = obj.vendor_id;
            return obj;
        });

        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch vendor products', error: error.message });
    }
};



module.exports = {
    getAllVendorProducts,
    getVendorProductById,
    createVendorProduct,
    updateVendorProduct,
    deleteVendorProduct,
    getVendorProductsByVendorId,
    importVendorProductFromExcel
};
