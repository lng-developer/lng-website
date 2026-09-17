const db = require('../models');
const VendorProduct = db.vendorProduct;
const VendorCostCenter = db.vendorCostCenter;
const Vendor = db.vendor;
const XLSX = require('xlsx');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const upload = multer({ dest: 'uploads/' }); // Tạm thời lưu file Excel

const value = (input) => String(input ?? '').trim();
const amount = (input) => {
    const parsed = Number.parseFloat(value(input).replace(/[, ]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
};
const status = (input) => value(input).toLowerCase() === 'inactive' ? 'Inactive' : 'Active';
const printingMethod = (input) => ['DTF', 'DTG'].includes(value(input).toUpperCase()) ? value(input).toUpperCase() : '';
const removeUpload = (filePath) => {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

const importVendorProductFromExcel = async (req, res) => {
    const filePath = req.file?.path && path.resolve(req.file.path);
    try {
        const vendorId = req.body.vendor_id;
        if (!vendorId) {
            return res.status(400).json({ message: 'Missing vendor_id in query' });
        }

        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const vendor = await Vendor.findById(vendorId);
        if (!vendor) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

        if (rawData.length === 0) {
            return res.status(400).json({ message: 'Excel file is empty' });
        }

        const rows = rawData.map((row, index) => {
            const productId = value(row.product_id);
            const productName = value(row.product_name);
            if (!productId || !productName) {
                const error = new Error(`Row ${index + 2}: product_id and product_name are required`);
                error.statusCode = 400;
                throw error;
            }

            const sku = value(row.sku || row.product_code);
            const vendorSize = value(row.vendor_size);
            const vendorColor = value(row.vendor_color);
            const hasVariant = [sku, vendorSize, vendorColor, row.standard_size, row.standard_color].some(value);
            if (hasVariant && (!sku || !vendorSize || !vendorColor)) {
                const error = new Error(`Row ${index + 2}: sku, vendor_size and vendor_color are required for a variant`);
                error.statusCode = 400;
                throw error;
            }

            return {
                productId,
                product: {
                    vendor_id: vendorId,
                    product_id: productId,
                    product_name: productName,
                    image: value(row.image),
                    product_type_design: value(row.product_type_design),
                    status: status(row.product_status || row.status),
                },
                variant: hasVariant && {
                    sku,
                    vendor_size: vendorSize,
                    vendor_color: vendorColor,
                    standard_size: value(row.standard_size) || vendorSize,
                    standard_color: value(row.standard_color) || vendorColor,
                    base_cost: amount(row.base_cost),
                    dosmetic: { economy: amount(row.domestic_economy), additional: amount(row.domestic_additional) },
                    international: { economy: amount(row.international_economy), additional: amount(row.international_additional) },
                    priority: { economy: amount(row.priority_economy), additional: amount(row.priority_additional) },
                    additional_costs: {
                        embroidery: amount(row.embroidery_cost),
                        two_sided_print: amount(row.two_sided_print_cost),
                        two_position_print: amount(row.two_position_print_cost),
                    },
                    printing_method: printingMethod(row.printing_method),
                    product_type_design: value(row.product_type_design),
                    status: status(row.variant_status || row.status),
                },
            };
        });

        const productRows = new Map();
        rows.forEach((row) => {
            if (!productRows.has(row.productId)) productRows.set(row.productId, row.product);
        });
        const products = new Map();
        for (const [productId, product] of productRows) {
            products.set(productId, await VendorProduct.findOneAndUpdate(
                { vendor_id: vendorId, product_id: productId },
                { $set: product },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            ));
        }

        const variants = rows.filter((row) => row.variant);
        for (const row of variants) {
            const vendorProduct = products.get(row.productId);
            await VendorCostCenter.findOneAndUpdate(
                {
                    vendor_product: vendorProduct._id,
                    sku: row.variant.sku,
                    vendor_size: row.variant.vendor_size,
                    vendor_color: row.variant.vendor_color,
                },
                { $set: { ...row.variant, vendor_product: vendorProduct._id } },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );
        }

        return res.status(201).json({
            message: 'Import successful',
            productsUpserted: products.size,
            variantsUpserted: variants.length,
        });
    } catch (error) {
        return res.status(error.statusCode || 500).json({ message: 'Failed to import vendor products', error: error.message });
    } finally {
        removeUpload(filePath);
    }
};

const mongoose = require('mongoose');

const getAllVendorProducts = async (req, res) => {
    try {
        const {
            vendor_id,
            status,
            product_type_design,
            search,
            vendor_name,     // filter theo tên vendor
            page = 1,
            perPage = 10,
            all              // all=true -> bỏ phân trang
        } = req.query;

        const pageNum = parseInt(page, 10) || 1;
        const perPageRaw = (typeof perPage === 'string') ? perPage.toLowerCase() : perPage;
        const loadAll =
            all === 'true' || perPageRaw === 'all' || Number(perPageRaw) === 0;

        const limit = loadAll ? undefined : (parseInt(perPage, 10) || 10);
        const skip = loadAll ? undefined : (pageNum - 1) * limit;

        const matchStage = {};

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

        return res.json({
            total,
            page: loadAll ? 1 : pageNum,
            perPage: loadAll ? total : limit,
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
