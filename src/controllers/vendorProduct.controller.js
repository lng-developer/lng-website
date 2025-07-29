const db = require('../models');
const VendorProduct = db.vendorProduct;

const getAllVendorProducts = async (req, res) => {
    const list = await VendorProduct.find().populate('vendorId').populate('productId');
    res.json(list);
};

const getVendorProductById = async (req, res) => {
    const item = await VendorProduct.findById(req.params.id);
    res.json(item);
};

const createVendorProduct = async (req, res) => {
    const item = await VendorProduct.create(req.body);
    res.status(201).json(item);
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
