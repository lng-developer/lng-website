const mongoose = require("mongoose")
const db = require('../models');
const ConfigCostCenter = db.configCostCenter;

// CREATE
const createConfig = async (req, res) => {
    try {
        const payload = req.body;

        if (!payload.platform || !payload.config_code || !payload.country) {
            return res.status(400).json({ message: 'platform, config_code, country are required' });
        }

        // Validate product_for_seller nếu có
        if (payload.product_for_seller && !mongoose.isValidObjectId(payload.product_for_seller)) {
            return res.status(400).json({ message: 'product_for_seller is not a valid ObjectId' });
        }

        const doc = await ConfigCostCenter.create({
            ...payload,
            history: [{ action: 'create', by: req.user?._id, diff: payload }]
        });

        const populated = await doc.populate('product_for_seller');
        res.status(201).json({ message: 'Created', data: populated });
    } catch (err) {
        res.status(500).json({ message: 'Create failed', error: err.message });
    }
};

// LIST + FILTER + PAGINATION (+ search theo tên ProductType)
const listConfigs = async (req, res) => {
    try {
        const {
            page = 1,
            perPage = 10,
            platform,
            country,
            status,
            is_set,
            is_pack,
            code,
            product_for_seller,
            product_for_seller_name,
            search,
            sort = '-created_at'
        } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(perPage);
        const limit = parseInt(perPage);

        // Khi cần lọc theo tên ProductType, dùng aggregate + $lookup
        const useAggForName = product_for_seller_name && product_for_seller_name.trim() !== '';

        if (useAggForName) {
            const match = { is_deleted: false };
            if (platform) match.platform = platform;
            if (country) match.country = country;
            if (status) match.status = status;
            if (typeof is_set !== 'undefined') match.is_set = is_set === 'true';
            if (typeof is_pack !== 'undefined') match.is_pack = is_pack === 'true';
            if (search) match.config_code = search;
            if (product_for_seller && mongoose.isValidObjectId(product_for_seller)) {
                match.product_for_seller = new mongoose.Types.ObjectId(product_for_seller);
            }

            const pipeline = [
                { $match: match },
                {
                    $lookup: {
                        from: 'producttypes',
                        localField: 'product_for_seller',
                        foreignField: '_id',
                        as: 'product_for_seller'
                    }
                },
                { $unwind: { path: '$product_for_seller', preserveNullAndEmptyArrays: true } },
                {
                    $match: {
                        'product_for_seller.name': { $regex: product_for_seller_name, $options: 'i' }
                    }
                },
                { $sort: buildSort(sort) },
                {
                    $facet: {
                        items: [{ $skip: skip }, { $limit: limit }],
                        total: [{ $count: 'count' }]
                    }
                }
            ];

            const [agg] = await ConfigCostCenter.aggregate(pipeline);
            const total = agg.total[0]?.count || 0;
            return res.json({ message: 'OK', page: Number(page), perPage: Number(perPage), total, items: agg.items });
        }

        // Trường hợp bình thường dùng find + populate
        const filter = { is_deleted: false };
        if (platform) filter.platform = platform;
        if (country) filter.country = country;
        if (status) filter.status = status;
        if (typeof is_set !== 'undefined') filter.is_set = is_set === 'true';
        if (typeof is_pack !== 'undefined') filter.is_pack = is_pack === 'true';
        if (code) filter.config_code = code;
        if (product_for_seller && mongoose.isValidObjectId(product_for_seller)) {
            filter.product_for_seller = product_for_seller;
        }
        if (search) filter.$text = { $search: search };

        const [total, items] = await Promise.all([
            ConfigCostCenter.countDocuments(filter),
            ConfigCostCenter.find(filter)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .populate('product_for_seller')
                .lean()
        ]);

        res.json({ message: 'OK', page: Number(page), perPage: Number(perPage), total, items });
    } catch (err) {
        res.status(500).json({ message: 'Fetch failed', error: err.message });
    }
};

// GET DETAIL
const getConfig = async (req, res) => {
    try {
        const item = await ConfigCostCenter.findOne({ _id: req.params.id, is_deleted: false })
            .populate('product_for_seller');
        if (!item) return res.status(404).json({ message: 'Not found' });
        res.json({ message: 'OK', data: item });
    } catch (err) {
        res.status(500).json({ message: 'Get failed', error: err.message });
    }
};

// UPDATE
const updateConfig = async (req, res) => {
    try {
        const id = req.params.id;
        const before = await ConfigCostCenter.findOne({ _id: id, is_deleted: false });
        if (!before) return res.status(404).json({ message: 'Not found' });
        if (req.body.product_for_seller && !mongoose.isValidObjectId(req.body.product_for_seller)) {
            return res.status(400).json({ message: 'product_for_seller is not a valid ObjectId' });
        }

        const updated = await ConfigCostCenter.findByIdAndUpdate(
            id,
            { $set: req.body, $push: { history: { action: 'update', by: req.user?._id, diff: req.body } } },
            { new: true }
        ).populate('product_for_seller');

        res.json({ message: 'Updated', data: updated });
    } catch (err) {
        res.status(500).json({ message: 'Update failed', error: err.message });
    }
};

// PATCH status
const toggleStatus = async (req, res) => {
    try {
        const { status } = req.body; // 'Active' | 'Inactive'
        if (!['Active', 'Inactive'].includes(status)) {
            return res.status(400).json({ message: 'status must be Active or Inactive' });
        }
        const item = await ConfigCostCenter.findOneAndUpdate(
            { _id: req.params.id, is_deleted: false },
            { $set: { status }, $push: { history: { action: 'toggle', by: req.user?._id, diff: { status } } } },
            { new: true }
        ).populate('product_for_seller');

        if (!item) return res.status(404).json({ message: 'Not found' });
        res.json({ message: 'Toggled', data: item });
    } catch (err) {
        res.status(500).json({ message: 'Toggle failed', error: err.message });
    }
};

// PATCH quick toggle is_set / is_pack
const toggleFlags = async (req, res) => {
    try {
        const patch = {};
        if (typeof req.body.is_set !== 'undefined') patch.is_set = !!req.body.is_set;
        if (typeof req.body.is_pack !== 'undefined') patch.is_pack = !!req.body.is_pack;
        if (!Object.keys(patch).length) {
            return res.status(400).json({ message: 'No flag provided' });
        }
        const item = await ConfigCostCenter.findOneAndUpdate(
            { _id: req.params.id, is_deleted: false },
            { $set: patch, $push: { history: { action: 'toggle', by: req.user?._id, diff: patch } } },
            { new: true }
        ).populate('product_for_seller');

        if (!item) return res.status(404).json({ message: 'Not found' });
        res.json({ message: 'Flags updated', data: item });
    } catch (err) {
        res.status(500).json({ message: 'Toggle flags failed', error: err.message });
    }
};

// SOFT DELETE
const removeConfig = async (req, res) => {
    try {
        const item = await ConfigCostCenter.findOneAndUpdate(
            { _id: req.params.id, is_deleted: false },
            { $set: { is_deleted: true }, $push: { history: { action: 'delete', by: req.user?._id } } },
            { new: true }
        );
        if (!item) return res.status(404).json({ message: 'Not found' });
        res.json({ message: 'Deleted', data: item._id });
    } catch (err) {
        res.status(500).json({ message: 'Delete failed', error: err.message });
    }
};

// Helper build sort string -> object
function buildSort(sort) {
    // ví dụ: "-created_at" hoặc "platform,config_code"
    if (!sort) return { created_at: -1 };
    const fields = sort.split(',').map(s => s.trim()).filter(Boolean);
    const o = {};
    for (const f of fields) {
        if (f.startsWith('-')) o[f.slice(1)] = -1;
        else o[f] = 1;
    }
    return o;
}

module.exports = {
    createConfig,
    listConfigs,
    getConfig,
    updateConfig,
    toggleStatus,
    toggleFlags,
    removeConfig
};
