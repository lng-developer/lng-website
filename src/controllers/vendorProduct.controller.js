const db = require('../models');
const VendorProduct = db.vendorProduct;

const getAllVendorProducts = async (req, res) => {
    try {
        const {
            vendor_id,
            status,
            product_type_design,
            search,
            vendor_name, // <-- thêm trường này
            page = 1,
            perPage = 10
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(perPage);
        const limit = parseInt(perPage);

        const matchStage = {};

        if (vendor_id) {
            matchStage.vendor_id = new mongoose.Types.ObjectId(vendor_id);
        }

        if (status) {
            matchStage.status = status;
        }

        if (product_type_design) {
            matchStage.product_type_design = product_type_design;
        }

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
            { $unwind: '$vendor' }
        ];

        if (vendor_name) {
            aggregatePipeline.push({
                $match: {
                    'vendor.name': { $regex: vendor_name, $options: 'i' }
                }
            });
        }

        // Clone pipeline for counting total documents
        const countPipeline = [...aggregatePipeline, { $count: 'total' }];

        aggregatePipeline.push({ $sort: { created_at: -1 } });
        aggregatePipeline.push({ $skip: skip });
        aggregatePipeline.push({ $limit: limit });

        const [countResult, items] = await Promise.all([
            VendorProduct.aggregate(countPipeline),
            VendorProduct.aggregate(aggregatePipeline)
        ]);

        const total = countResult[0]?.total || 0;

        res.json({
            total,
            page: parseInt(page),
            perPage: parseInt(perPage),
            data: items
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch vendor products', error: error.message });
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
            .populate('vendor_id')

        res.status(200).json(products);
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
    getVendorProductsByVendorId
};
