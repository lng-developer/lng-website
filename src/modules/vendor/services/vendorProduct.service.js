// src/modules/vendor/services/vendorProduct.service.js
const db = require('../../../models');
const VendorProduct = db.vendorProduct;
const mongoose = require('mongoose');

const getAllVendorProducts = async (filters) => {
    const {
        vendor_id,
        status,
        product_type_design,
        search,
        vendor_name,     // filter theo tên vendor
        page = 1,
        perPage = 10,
        all              // all=true -> bỏ phân trang
    } = filters;

    const pageNum = parseInt(page, 10) || 1;
    const perPageRaw = (typeof perPage === 'string') ? perPage.toLowerCase() : perPage;
    const loadAll = all === 'true' || perPageRaw === 'all' || Number(perPageRaw) === 0;

    const limit = loadAll ? undefined : (parseInt(perPage, 10) || 10);
    const skip = loadAll ? undefined : (pageNum - 1) * limit;

    const matchStage = {};

    if (vendor_id) {
        if (!mongoose.isValidObjectId(vendor_id)) {
            const err = new Error('Invalid vendor_id');
            err.status = 400;
            throw err;
        }
        matchStage.vendor_id = new mongoose.Types.ObjectId(vendor_id);
    }

    if (status) matchStage.status = status;
    if (product_type_design) matchStage.product_type_design = product_type_design;

    if (search) {
        matchStage.product_name = { $regex: search, $options: 'i' };
    }

    const aggregatePipeline = [
        { $match: matchStage },
        {
            $lookup: {
                from: 'vendors',
                localField: 'vendor_id',
                foreignField: '_id',
                as: 'vendor'
            }
        },
        // Nếu muốn KHÔNG làm rớt bản ghi thiếu vendor, dùng preserveNullAndEmptyArrays: true
        { $unwind: '$vendor' }
    ];

    if (vendor_name) {
        aggregatePipeline.push({
            $match: { 'vendor.name': { $regex: vendor_name, $options: 'i' } }
        });
    }

    // Đếm tổng sau khi áp tất cả filter (kể cả vendor_name)
    const countPipeline = [...aggregatePipeline, { $count: 'total' }];

    // Sort luôn áp dụng
    aggregatePipeline.push({ $sort: { created_at: -1 } });

    // Chỉ áp dụng skip/limit khi KHÔNG loadAll
    if (!loadAll) {
        aggregatePipeline.push({ $skip: skip });
        aggregatePipeline.push({ $limit: limit });
    }

    const [countResult, items] = await Promise.all([
        VendorProduct.aggregate(countPipeline),
        VendorProduct.aggregate(aggregatePipeline)
    ]);

    const total = countResult[0]?.total || 0;

    return {
        total,
        page: loadAll ? 1 : pageNum,
        perPage: loadAll ? total : limit,
        data: items
    };
};

const getVendorProductById = async (id) => {
    return await VendorProduct.findById(id);
};

const createVendorProduct = async (data) => {
    if (Array.isArray(data)) {
        if (data.length === 0) {
            const err = new Error('Empty array provided');
            err.status = 400;
            throw err;
        }
        return await VendorProduct.insertMany(data);
    }
    // Nếu là object → tạo 1 bản ghi
    return await VendorProduct.create(data);
};

const updateVendorProduct = async (id, data) => {
    return await VendorProduct.findByIdAndUpdate(id, data, { new: true });
};

const deleteVendorProduct = async (id) => {
    await VendorProduct.findByIdAndDelete(id);
};

const getVendorProductsByVendorId = async (vendorId) => {
    if (!vendorId) {
        const err = new Error('Missing vendorId in params');
        err.status = 400;
        throw err;
    }

    const products = await VendorProduct.find({ vendor_id: vendorId })
        .populate({
            path: 'vendor_id',
            select: 'name status fulfillment_type'
        })
        .sort({ created_at: -1 });

    // Chuẩn hóa: thêm field vendor
    return products.map(p => {
        const obj = p.toObject();
        obj.vendor = obj.vendor_id;
        return obj;
    });
};

const importVendorProductFromExcel = async (vendorId, rawData) => {
    if (!vendorId) {
        const err = new Error('Missing vendor_id in query');
        err.status = 400;
        throw err;
    }

    if (!rawData || rawData.length === 0) {
        const err = new Error('Excel file is empty');
        err.status = 400;
        throw err;
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
    return { message: 'Import successful', insertedCount: inserted.length };
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

