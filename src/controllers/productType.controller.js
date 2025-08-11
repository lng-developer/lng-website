const mongoose = require('mongoose');
const db = require('../models');
const ProductTypeGroup = db.productTypeGroup
const VendorProduct = db.vendorProduct
const VendorCostCenter = db.vendorCostCenter
/**
 * GET /product-types
 * Query: search, page, perPage, include=details
 * - include=details (true) sẽ trả cả cost centers cho từng item
 */
exports.getGroups = async (req, res) => {
    try {
        const {
            search = '',
            page = 1,
            perPage = 10,
            include = 'summary' // 'summary' | 'details'
        } = req.query;

        const match = {};
        if (search) match.$text = { $search: search };

        const skip = (parseInt(page) - 1) * parseInt(perPage);
        const limit = parseInt(perPage);

        // Summary nhanh: không join nặng
        if (include !== 'details') {
            const [total, items] = await Promise.all([
                ProductTypeGroup.countDocuments(match),
                ProductTypeGroup.find(match)
                    .sort({ order: 1, created_at: -1 })
                    .skip(skip).limit(limit)
                    .select('name order items created_at updated_at')
            ]);
            return res.json({ total, items, page: +page, perPage: +perPage });
        }

        // Details: aggregate để trả cả cost centers
        const pipeline = [
            { $match: match },
            { $sort: { order: 1, created_at: -1 } },
            { $skip: skip },
            { $limit: limit },

            // bung items để join
            { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },

            // join VendorProduct cho từng item
            {
                $lookup: {
                    from: 'vendorproducts',
                    localField: 'items.vendor_product',
                    foreignField: '_id',
                    as: 'vp'
                }
            },
            { $unwind: { path: '$vp', preserveNullAndEmptyArrays: true } },

            // join Vendor để lấy tên vendor
            {
                $lookup: {
                    from: 'vendors',
                    localField: 'vp.vendor_id',
                    foreignField: '_id',
                    as: 'vendor'
                }
            },
            { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },

            // join VendorCostCenter theo vendor_product
            {
                $lookup: {
                    from: 'vendorcostcenters',
                    let: { vpId: '$vp._id' },
                    pipeline: [
                        { $match: { $expr: { $eq: ['$vendor_product', '$$vpId'] } } },
                        {
                            $project: {
                                _id: 0,
                                sku: 1,
                                vendor_size: 1, vendor_color: 1,
                                standard_size: 1, standard_color: 1
                            }
                        },
                        { $sort: { sku: 1 } }
                    ],
                    as: 'cost_centers'
                }
            },

            // gom lại theo group
            {
                $group: {
                    _id: '$_id',
                    name: { $first: '$name' },
                    order: { $first: '$order' },
                    created_at: { $first: '$created_at' },
                    updated_at: { $first: '$updated_at' },
                    items: {
                        $push: {
                            $cond: {
                                if: { $ne: ['$items', null] },  // Chỉ push nếu items không null
                                then: {
                                    _id: '$items._id',
                                    order: '$items.order',
                                    display_name: '$items.display_name',
                                    is_variant: '$items.is_variant',
                                    status: '$items.status',
                                    vendor_product: '$vp._id',
                                    product_id: '$vp.product_id',
                                    product_name: '$vp.product_name',
                                    vendor_name: '$vendor.name',
                                    cost_centers: '$cost_centers'
                                },
                                else: '$$REMOVE'  // Bỏ qua push nếu null
                            }
                        }
                    }
                }
            },

            // sort items theo order
            {
                $addFields: {
                    items: {
                        $filter: { input: '$items', as: 'it', cond: { $ne: ['$$it', null] } }
                    }
                }
            }
        ];

        const [total, groups] = await Promise.all([
            ProductTypeGroup.countDocuments(match),
            ProductTypeGroup.aggregate(pipeline)
        ]);

        // sort items phía server (đề phòng Mongo giữ thứ tự push)
        groups.forEach(g => g.items.sort((a, b) => a.order - b.order));

        res.json({ total, items: groups, page: +page, perPage: +perPage });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

/**
 * POST /product-types
 * body: { name, order?, items: [{ vendor_product, display_name, is_variant?, status? }] }
 */
exports.createGroup = async (req, res) => {
    try {
        const { name, order, items = [] } = req.body;

        // auto order cho items
        const mapped = items.map((it, idx) => ({
            ...it,
            order: typeof it.order === 'number' ? it.order : idx + 1
        }));

        // nếu thiếu display_name thì lấy theo VendorProduct.product_name
        for (const it of mapped) {
            if (!it.display_name) {
                const vp = await VendorProduct.findById(it.vendor_product).lean();
                it.display_name = vp?.product_name || 'Unnamed';
            }
        }

        // order group (tăng dần)
        let groupOrder = order;
        if (typeof groupOrder !== 'number') {
            const max = await ProductTypeGroup.findOne().sort({ order: -1 }).select('order').lean();
            groupOrder = (max?.order || 0) + 1;
        }

        const doc = await ProductTypeGroup.create({ name, order: groupOrder, items: mapped });
        res.status(201).json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};

/**
 * PUT /product-types/:groupId
 * body: { name?, order? }
 */
exports.updateGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        const updates = (({ name, order }) => ({ name, order }))(req.body);
        const doc = await ProductTypeGroup.findByIdAndUpdate(groupId, updates, { new: true });
        if (!doc) return res.status(404).json({ message: 'Group not found' });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};

/**
 * DELETE /product-types/:groupId
 */
exports.deleteGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        const r = await ProductTypeGroup.findByIdAndDelete(groupId);
        if (!r) return res.status(404).json({ message: 'Group not found' });
        res.json({ message: 'Deleted' });
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};

/**
 * POST /product-types/:groupId/items
 * body: { vendor_product, display_name?, is_variant?, status? }
 */
exports.addItem = async (req, res) => {
    try {
        const { groupId } = req.params;
        const group = await ProductTypeGroup.findById(groupId);
        if (!group) return res.status(404).json({ message: 'Group not found' });

        const nextOrder = group.items.length
            ? Math.max(...group.items.map(i => i.order)) + 1
            : 1;

        const payload = { ...req.body, order: nextOrder };

        // autofill display_name nếu thiếu
        if (!payload.display_name) {
            const vp = await VendorProduct.findById(payload.vendor_product).lean();
            payload.display_name = vp?.product_name || 'Unnamed';
        }

        group.items.push(payload);
        await group.save();
        res.json(group);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};

/**
 * PUT /product-types/:groupId/items/:itemId
 * body: các trường item (display_name, is_variant, status, vendor_product?) + order? (nếu muốn đổi thứ tự 1 item)
 */
exports.updateItem = async (req, res) => {
    try {
        const { groupId, itemId } = req.params;
        const group = await ProductTypeGroup.findById(groupId);
        if (!group) return res.status(404).json({ message: 'Group not found' });

        const item = group.items.id(itemId);
        if (!item) return res.status(404).json({ message: 'Item not found' });

        Object.assign(item, req.body);
        await group.save();
        res.json(group);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};

/**
 * DELETE /product-types/:groupId/items/:itemId
 */
exports.deleteItem = async (req, res) => {
    try {
        const { groupId, itemId } = req.params;
        const group = await ProductTypeGroup.findById(groupId);
        if (!group) return res.status(404).json({ message: 'Group not found' });

        const item = group.items.id(itemId);
        if (!item) return res.status(404).json({ message: 'Item not found' });

        item.deleteOne();
        // Optionally: compact lại order
        group.items = group.items
            .sort((a, b) => a.order - b.order)
            .map((it, idx) => ({ ...it.toObject(), order: idx + 1 }));
        await group.save();

        res.json(group);
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};

/**
 * PUT /product-types/:groupId/reorder
 * body: { orders: [{ itemId, order }, ...] }
 */
exports.reorderItems = async (req, res) => {
    try {
        const { groupId } = req.params;
        const { orders = [] } = req.body;

        const group = await ProductTypeGroup.findById(groupId);
        if (!group) return res.status(404).json({ message: 'Group not found' });

        const map = new Map(orders.map(o => [String(o.itemId), o.order]));
        group.items.forEach(it => {
            const newOrder = map.get(String(it._id));
            if (typeof newOrder === 'number') it.order = newOrder;
        });

        group.items.sort((a, b) => a.order - b.order);
        await group.save();

        res.json({ message: 'Reordered', group });
    } catch (e) {
        res.status(400).json({ message: e.message });
    }
};
