// src/modules/catalog/services/productType.service.js
const db = require("../../../models");
const ProductTypeGroup = db.productTypeGroup;
const VendorProduct = db.vendorProduct;

const getGroups = async (filters) => {
    const { search = "", page = 1, perPage = 10 } = filters;

    const q = String(search || "").trim();
    const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = q ? new RegExp(escapeRegex(q), "i") : null;

    const skip = (parseInt(page) - 1) * parseInt(perPage);
    const limit = parseInt(perPage);

    const pipeline = [
        { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "vendorproducts",
                localField: "items.vendor_product",
                foreignField: "_id",
                as: "vp",
            },
        },
        { $unwind: { path: "$vp", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "vendors",
                localField: "vp.vendor_id",
                foreignField: "_id",
                as: "vendor",
            },
        },
        { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "vendorcostcenters",
                let: { vpId: "$vp._id" },
                pipeline: [
                    { $match: { $expr: { $eq: ["$vendor_product", "$$vpId"] } } },
                    {
                        $project: {
                            _id: 0,
                            sku: 1,
                            vendor_size: 1,
                            vendor_color: 1,
                            standard_size: 1,
                            standard_color: 1,
                        },
                    },
                    { $sort: { sku: 1 } },
                ],
                as: "cost_centers",
            },
        },
        ...(regex
            ? [
                {
                    $match: {
                        $or: [
                            { name: { $regex: regex } },
                            { "items.display_name": { $regex: regex } },
                            { "vp.product_name": { $regex: regex } },
                            { "vendor.name": { $regex: regex } },
                            { "cost_centers.sku": { $regex: regex } },
                        ],
                    },
                },
            ]
            : []),
        {
            $group: {
                _id: "$_id",
                name: { $first: "$name" },
                order: { $first: "$order" },
                created_at: { $first: "$created_at" },
                updated_at: { $first: "$updated_at" },
                items: {
                    $push: {
                        $cond: {
                            if: { $ne: ["$items", null] },
                            then: {
                                _id: "$items._id",
                                order: "$items.order",
                                display_name: "$items.display_name",
                                is_variant: "$items.is_variant",
                                status: "$items.status",
                                vendor_product: "$vp._id",
                                product_id: "$vp.product_id",
                                product_name: "$vp.product_name",
                                vendor_name: "$vendor.name",
                                cost_centers: "$cost_centers",
                            },
                            else: "$$REMOVE",
                        },
                    },
                },
            },
        },
        {
            $addFields: {
                items: {
                    $filter: {
                        input: "$items",
                        as: "it",
                        cond: { $ne: ["$$it", null] },
                    },
                },
            },
        },
        { $sort: { name: 1 } },
        {
            $facet: {
                items: [{ $skip: skip }, { $limit: limit }],
                total: [{ $count: "count" }],
            },
        },
    ];

    const [agg] = await ProductTypeGroup.aggregate(pipeline).collation({
        locale: "en",
        strength: 1,
        alternate: "shifted",
        numericOrdering: true,
    });

    const total = agg.total[0]?.count || 0;
    const groups = agg.items;
    groups.forEach((g) => g.items.sort((a, b) => a.order - b.order));

    return { total, items: groups, page: +page, perPage: +perPage };
};

const createGroup = async (groupData) => {
    const { name, order, items = [] } = groupData;

    const mapped = items.map((it, idx) => ({
        ...it,
        order: typeof it.order === "number" ? it.order : idx + 1,
    }));

    for (const it of mapped) {
        if (!it.display_name) {
            const vp = await VendorProduct.findById(it.vendor_product).lean();
            it.display_name = vp?.product_name || "Unnamed";
        }
    }

    let groupOrder = order;
    if (typeof groupOrder !== "number") {
        const max = await ProductTypeGroup.findOne()
            .sort({ order: -1 })
            .select("order")
            .lean();
        groupOrder = (max?.order || 0) + 1;
    }

    return await ProductTypeGroup.create({
        name,
        order: groupOrder,
        items: mapped,
    });
};

const updateGroup = async (groupId, updateData) => {
    const updates = (({ name, order }) => ({ name, order }))(updateData);
    const doc = await ProductTypeGroup.findByIdAndUpdate(groupId, updates, {
        new: true,
    });
    if (!doc) {
        const error = new Error("Group not found");
        error.status = 404;
        throw error;
    }
    return doc;
};

const deleteGroup = async (groupId) => {
    const r = await ProductTypeGroup.findByIdAndDelete(groupId);
    if (!r) {
        const error = new Error("Group not found");
        error.status = 404;
        throw error;
    }
};

const addItem = async (groupId, itemData) => {
    const group = await ProductTypeGroup.findById(groupId);
    if (!group) {
        const error = new Error("Group not found");
        error.status = 404;
        throw error;
    }

    const nextOrder = group.items.length
        ? Math.max(...group.items.map((i) => i.order)) + 1
        : 1;

    const payload = { ...itemData, order: nextOrder };

    if (!payload.display_name) {
        const vp = await VendorProduct.findById(payload.vendor_product).lean();
        payload.display_name = vp?.product_name || "Unnamed";
    }

    group.items.push(payload);
    await group.save();
    return group;
};

const updateItem = async (groupId, itemId, updateData) => {
    const group = await ProductTypeGroup.findById(groupId);
    if (!group) {
        const error = new Error("Group not found");
        error.status = 404;
        throw error;
    }

    const item = group.items.id(itemId);
    if (!item) {
        const error = new Error("Item not found");
        error.status = 404;
        throw error;
    }

    Object.assign(item, updateData);
    await group.save();
    return group;
};

const deleteItem = async (groupId, itemId) => {
    const group = await ProductTypeGroup.findById(groupId);
    if (!group) {
        const error = new Error("Group not found");
        error.status = 404;
        throw error;
    }

    const item = group.items.id(itemId);
    if (!item) {
        const error = new Error("Item not found");
        error.status = 404;
        throw error;
    }

    item.deleteOne();
    group.items = group.items
        .sort((a, b) => a.order - b.order)
        .map((it, idx) => ({ ...it.toObject(), order: idx + 1 }));

    await group.save();
    return group;
};

const reorderItems = async (groupId, ordersData) => {
    const { orders = [] } = ordersData;

    const group = await ProductTypeGroup.findById(groupId);
    if (!group) {
        const error = new Error("Group not found");
        error.status = 404;
        throw error;
    }

    const map = new Map(orders.map((o) => [String(o.itemId), o.order]));
    group.items.forEach((it) => {
        const newOrder = map.get(String(it._id));
        if (typeof newOrder === "number") it.order = newOrder;
    });

    group.items.sort((a, b) => a.order - b.order);
    await group.save();

    return { message: "Reordered", group };
};

module.exports = {
    getGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    addItem,
    updateItem,
    deleteItem,
    reorderItems,
};

