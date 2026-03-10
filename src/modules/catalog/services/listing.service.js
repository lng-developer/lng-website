// src/modules/catalog/services/listing.service.js
const db = require('../../../models');
const Listing = db.listing;
const OrderCustomProduct = db.orderCustomProduct;
const {
    uploadBufferToWasabi,
    getSignedUrlForKey,
    buildPsdKeyFromAsin,
} = require("../../../utils/wasabi");

// Helpers
function hasRole(userRole, target) {
    if (!userRole) return false;
    if (Array.isArray(userRole)) {
        return userRole.some(
            (r) => String(r).toLowerCase() === String(target).toLowerCase()
        );
    }
    return String(userRole).toLowerCase() === String(target).toLowerCase();
}

function buildDesignKeyByExt(asin, ext) {
    ext = (ext || ".psd").toLowerCase();
    return `psd/${asin}/${asin}${ext}`;
}

const getListings = async (filters, currentUser) => {
    const {
        page = 1,
        perPage = 10,
        asinType,
        asinTypeMode,
        seller,
        platform,
        sort = "createdAt",
        order = "desc",
        search,
        psdStatus,
        from,
        to,
        store,
    } = filters;

    const filter = {};

    // ===== RBAC =====
    const role = currentUser?.role;
    const userId = currentUser?.userId;

    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);

    if (isSeller && !isAdmin) {
        filter.seller = userId;
    } else if (seller) {
        filter.seller = seller;
    }

    // Filters
    if (asinType) filter.asin_type = asinType;
    if (asinTypeMode === "excludeOutline") {
        filter.asin_type = { $ne: "Outline" };
    } else if (asinTypeMode === "onlyOutline") {
        filter.asin_type = "Outline";
    }

    if (platform) filter.platform = platform;
    if (store) filter.store = store;

    if (psdStatus) {
        const statuses = psdStatus
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (statuses.length === 1) {
            filter["psd.status"] = statuses[0];
        } else if (statuses.length > 1) {
            filter["psd.status"] = { $in: statuses };
        }
    }

    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }

    if (search) {
        const regex = new RegExp(search, "i");
        filter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(perPage, 10) || 10, 1);
    const skip = (pageNum - 1) * limitNum;

    const total = await Listing.countDocuments(filter);
    let listings;

    if (sort === "total_sales") {
        const allListings = await Listing.find(filter)
            .populate({ path: "seller", select: "full_name" })
            .populate({ path: "store", select: "name" })
            .lean();

        const listingIds = allListings.map((l) => l._id).filter(Boolean);
        let salesMap = new Map();

        if (listingIds.length > 0) {
            const agg = await OrderCustomProduct.aggregate([
                { $match: { "items.listingId": { $in: listingIds } } },
                { $unwind: "$items" },
                { $match: { "items.listingId": { $in: listingIds } } },
                {
                    $group: {
                        _id: { listingId: "$items.listingId", orderId: "$orderId" },
                    },
                },
                { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
            ]);

            salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
        }

        const listingsWithSales = allListings.map((l) => ({
            ...l,
            total_sales: salesMap.get(String(l._id)) || 0,
        }));

        listingsWithSales.sort((a, b) =>
            order === "asc"
                ? a.total_sales - b.total_sales
                : b.total_sales - a.total_sales
        );

        // Pagination sau khi sort
        listings = listingsWithSales.slice(skip, skip + limitNum);

    } else if (sort === "seller_name") {
        const pipeline = [
            { $match: filter },
            {
                $lookup: {
                    from: "users",
                    localField: "seller",
                    foreignField: "_id",
                    as: "seller",
                },
            },
            { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "stores",
                    localField: "store",
                    foreignField: "_id",
                    as: "store",
                },
            },
            { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
            {
                $addFields: {
                    seller_name: { $ifNull: ["$seller.full_name", ""] },
                },
            },
            { $sort: { seller_name: order === "asc" ? 1 : -1 } },
            { $skip: skip },
            { $limit: limitNum },
            {
                $project: {
                    seller: { _id: 1, full_name: 1 },
                    store: { _id: 1, name: 1 },
                    asin: 1,
                    asin_type: 1,
                    platform: 1,
                    psd: 1,
                    template: 1,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
        ];

        listings = await Listing.aggregate(pipeline);

        const listingIds = listings.map((l) => l._id).filter(Boolean);
        let salesMap = new Map();

        if (listingIds.length > 0) {
            const agg = await OrderCustomProduct.aggregate([
                { $match: { "items.listingId": { $in: listingIds } } },
                { $unwind: "$items" },
                { $match: { "items.listingId": { $in: listingIds } } },
                {
                    $group: {
                        _id: { listingId: "$items.listingId", orderId: "$orderId" },
                    },
                },
                { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
            ]);

            salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
        }

        listings = listings.map((l) => ({
            ...l,
            total_sales: salesMap.get(String(l._id)) || 0,
        }));

    } else {
        const mongoSort = { [sort]: order === "asc" ? 1 : -1 };

        listings = await Listing.find(filter)
            .sort(mongoSort)
            .skip(skip)
            .limit(limitNum)
            .populate({ path: "seller", select: "full_name" })
            .populate({ path: "store", select: "name" })
            .lean();

        const listingIds = listings.map((l) => l._id).filter(Boolean);
        let salesMap = new Map();

        if (listingIds.length > 0) {
            const agg = await OrderCustomProduct.aggregate([
                { $match: { "items.listingId": { $in: listingIds } } },
                { $unwind: "$items" },
                { $match: { "items.listingId": { $in: listingIds } } },
                {
                    $group: {
                        _id: { listingId: "$items.listingId", orderId: "$orderId" },
                    },
                },
                { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
            ]);

            salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
        }

        listings = listings.map((l) => ({
            ...l,
            total_sales: salesMap.get(String(l._id)) || 0,
        }));
    }

    return { total, listings, page: pageNum, perPage: limitNum };
};

const getPsdStatistics = async (filters) => {
    const {
        from,
        to,
        store,
        seller,
        platform,
        asinType,
        search,
        asinTypeMode,
    } = filters;

    const baseFilter = {};

    if (from && to) {
        baseFilter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    if (store) baseFilter.store = store;
    if (seller) baseFilter.seller = seller;
    if (platform) baseFilter.platform = platform;
    if (asinType) baseFilter.asin_type = asinType;
    if (asinTypeMode === "excludeOutline") {
        baseFilter.asin_type = { $ne: "Outline" };
    } else if (asinTypeMode === "onlyOutline") {
        baseFilter.asin_type = "Outline";
    }

    if (search) {
        const regex = new RegExp(search, "i");
        baseFilter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    const all = await Listing.countDocuments(baseFilter);

    const pending = await Listing.countDocuments({
        ...baseFilter,
        "psd.status": "Unavailable",
    });

    const complete = await Listing.countDocuments({
        ...baseFilter,
        "psd.status": "Available",
    });

    return { all, pending, complete };
};

const getListingStatistics = async (filters, currentUser) => {
    const { from, to, store, seller, platform, search } = filters;

    // ===== RBAC =====
    const role = currentUser?.role;
    const userId = currentUser?.userId;
    const isAdmin = hasRole(role, "Admin");
    const isSeller = hasRole(role, "Seller");

    const baseFilter = {};

    if (isSeller && !isAdmin) {
        baseFilter.seller = userId;
    } else if (seller) {
        baseFilter.seller = seller;
    }

    if (from || to) {
        baseFilter.createdAt = {};
        if (from) baseFilter.createdAt.$gte = new Date(from);
        if (to) baseFilter.createdAt.$lte = new Date(to);
    }

    if (store) baseFilter.store = store;
    if (platform) baseFilter.platform = platform;

    if (search) {
        const regex = new RegExp(search, "i");
        baseFilter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    const totalAsin = await Listing.countDocuments(baseFilter);

    const psdAvailable = await Listing.countDocuments({
        ...baseFilter,
        "psd.status": "Available",
    });

    const noPsd = await Listing.countDocuments({
        ...baseFilter,
        $or: [
            { psd: { $exists: false } },
            { "psd.status": { $ne: "Available" } },
        ],
    });

    const anonymousAsin = 0;

    const asinTypes = [
        "First Sale",
        "Normal",
        "Outline",
        "Custom Image",
        "POD Lovers",
        "Style",
        "Tool",
        "Auto Fulfill",
        "Others",
    ];

    const asinTypeAgg = await Listing.aggregate([
        { $match: baseFilter },
        { $group: { _id: "$asin_type", count: { $sum: 1 } } },
    ]);

    const asinTypeCounts = {};
    for (const t of asinTypes) asinTypeCounts[t] = 0;

    for (const row of asinTypeAgg) {
        const key = row._id || "Others";
        if (asinTypeCounts.hasOwnProperty(key)) {
            asinTypeCounts[key] += row.count;
        } else {
            asinTypeCounts["Others"] += row.count;
        }
    }

    asinTypeCounts.All = totalAsin;

    return {
        totalAsin,
        anonymousAsin,
        psdAvailable,
        noPsd,
        asinTypeCounts,
    };
};

const upsertListing = async (data) => {
    return await Listing.findOneAndUpdate(
        { asin: data.asin },
        { $set: data },
        { upsert: true, new: true }
    );
};

const updateListingPSD = async (asin, status, fileInfo) => {
    const { buffer, originalname, size } = fileInfo;

    if (!asin) {
        throw new Error('Thiếu asin');
    }
    if (!buffer) {
        throw new Error('Thiếu file buffer');
    }

    status = status === 'Unavailable' ? 'Unavailable' : 'Available';

    const originalName = originalname || `${asin}.zip`;
    const ext = ".zip";
    const key = buildDesignKeyByExt(asin, ext);
    const contentType = "application/zip";

    const { url } = await uploadBufferToWasabi(buffer, {
        key,
        contentType,
    });

    const updated = await Listing.findOneAndUpdate(
        { asin },
        {
            $set: {
                "psd.psd_id": asin,
                "psd.url": url,
                "psd.status": status,
                "psd.file_name": originalName,
                "psd.file_ext": ext,
                "psd.mime": contentType,
                "psd.size": size || null,
                "psd.archive": true,
                date_updated: new Date(),
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return {
        message: "Cập nhật file thiết kế thành công",
        file_type: "ZIP",
        key,
        listing: updated,
    };
};

const getPsdSignedUrl = async (asin, queries) => {
    const expires = Math.max(
        60,
        Math.min(86400, Number(queries.expires) || 3600)
    );
    const asAttachment = String(queries.download || "") === "1";

    const listing = await Listing.findOne({ asin }).lean();
    if (!listing) {
        const err = new Error("Listing không tồn tại");
        err.status = 404;
        throw err;
    }

    const ext = (listing.psd?.file_ext || ".zip").toLowerCase();
    const key = buildDesignKeyByExt(asin, ext);
    const filename = `${asin}${ext}`;

    const url = await getSignedUrlForKey(key, {
        expiresIn: expires,
        asAttachment,
        filename,
    });

    return { asin, key, signed_url: url, expires_in: expires };
};

const deleteListing = async (id) => {
    await Listing.findOneAndDelete({ _id: id });
};

const updateListing = async (id, data) => {
    await Listing.findByIdAndUpdate(id, data, { new: true });
};

const importListingsFromExcelData = async (rows) => {
    const listingsToInsert = [];

    const fieldColumnMapping = {
        asin: "ASIN",
        product_image: "Image",
        total_sales: "Total Sales",
        platform: "Platform",
        store: "Store",
        seller: "Seller",
        thread_color: "Thread Color",
        thread_note: "Thread Note",
        asin_type: "ASIN Type",
        other_config: "Other Config",
        "template.style": "Style",
        "template.sub_style": "Sub Style",
        "template.design_product": "Design Product",
        "template.variant": "Variant",
        "psd.psd_id": "PSD ID",
        "psd.status": "PSD Status",
    };

    const formatColumnName = (fieldName) => fieldColumnMapping[fieldName] || fieldName;

    for (const row of rows) {
        const asin = row[formatColumnName("asin")]?.toString().trim();
        if (!asin) continue;

        const newListing = { asin, template: {}, psd: {} };

        const topLevelFields = [
            "product_image",
            "total_sales",
            "platform",
            "store",
            "seller",
            "thread_color",
            "thread_note",
            "asin_type",
            "other_config",
        ];

        const templateFields = ["style", "sub_style", "design_product", "variant"];
        const psdFields = ["psd_id", "status"];

        topLevelFields.forEach((field) => {
            const col = formatColumnName(field);
            if (row[col] !== undefined) newListing[field] = row[col];
        });

        templateFields.forEach((field) => {
            const col = formatColumnName(`template.${field}`);
            if (row[col] !== undefined) newListing.template[field] = row[col];
        });

        psdFields.forEach((field) => {
            const col = formatColumnName(`psd.${field}`);
            if (row[col] !== undefined) {
                if (field === "status") {
                    newListing.psd.status =
                        row[col].toLowerCase() === "available" ? "Available" : "Unavailable";
                } else {
                    newListing.psd[field] = row[col];
                }
            }
        });

        newListing.template.variant ||= "All";
        newListing.psd.status ||= "Unavailable";
        newListing.platform ||= "Amazon";
        newListing.total_sales ||= 0;

        listingsToInsert.push(newListing);
    }

    if (listingsToInsert.length === 0) {
        const err = new Error("Không có bản ghi hợp lệ để import");
        err.status = 400;
        throw err;
    }

    await Listing.insertMany(listingsToInsert, { ordered: false });

    return {
        message: "Import thành công",
        inserted: listingsToInsert.length,
    };
};

const getAsinSellerStoreExportData = async (filters, currentUser) => {
    const {
        asinType,
        asinTypeMode,
        seller,
        platform,
        search,
        from,
        to,
        store,
    } = filters;

    const role = currentUser?.role;
    const userId = currentUser?.userId;

    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);

    const filter = {};

    if (isSeller && !isAdmin) {
        filter.seller = userId;
    } else if (seller) {
        filter.seller = seller;
    }

    if (asinType) filter.asin_type = asinType;
    if (asinTypeMode === "excludeOutline") {
        filter.asin_type = { $ne: "Outline" };
    } else if (asinTypeMode === "onlyOutline") {
        filter.asin_type = "Outline";
    }

    if (platform) filter.platform = platform;
    if (store) filter.store = store;

    if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = new Date(from);
        if (to) filter.createdAt.$lte = new Date(to);
    }

    if (search) {
        const regex = new RegExp(search, "i");
        filter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    const listings = await Listing.find(filter)
        .populate({ path: "seller", select: "full_name email" })
        .populate({ path: "store", select: "name" })
        .lean();

    if (!listings.length) {
        return { rows: [] };
    }

    const listingIds = listings.map((l) => l._id).filter(Boolean);
    let salesMap = new Map();

    if (listingIds.length > 0) {
        const agg = await OrderCustomProduct.aggregate([
            { $match: { "items.listingId": { $in: listingIds } } },
            { $unwind: "$items" },
            { $match: { "items.listingId": { $in: listingIds } } },
            {
                $group: {
                    _id: { listingId: "$items.listingId", orderId: "$orderId" },
                },
            },
            { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
        ]);

        salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
    }

    const rows = listings.map((l) => ({
        ASIN: l.asin || "",
        Platform: l.platform || "",
        "ASIN Type": l.asin_type || "",
        "Total Sales": salesMap.get(String(l._id)) || 0,
        "Seller ID": l.seller?._id?.toString() || "",
        "Seller Name": l.seller?.full_name || "",
        "Seller Email": l.seller?.email || "",
        "Store ID": l.store?._id?.toString() || "",
        "Store Name": l.store?.name || "",
        "Created At": l.createdAt
            ? new Date(l.createdAt).toISOString().slice(0, 19).replace("T", " ")
            : "",
    }));

    return { rows };
};

module.exports = {
    getListings,
    getPsdStatistics,
    getListingStatistics,
    upsertListing,
    updateListingPSD,
    getPsdSignedUrl,
    deleteListing,
    updateListing,
    importListingsFromExcelData,
    getAsinSellerStoreExportData
};

