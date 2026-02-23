const db = require('../models');
const EtsyOrder = db.EtsyOrder;
const User = db.user;

const fs = require('fs');
const { parse } = require('csv-parse');

// ================== UTIL ==================

const toNumber = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s) return null;
    const cleaned = s.replace(/[^0-9.\-]/g, "");
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
};

const toInt = (v) => {
    const n = toNumber(v);
    return n === null ? null : Math.trunc(n);
};

const toDate = (v) => {
    if (!v) return null;
    const d = new Date(String(v).trim());
    return Number.isNaN(d.getTime()) ? null : d;
};

const parseVariations = (raw) => {
    if (!raw) return {};
    const out = {};
    const parts = String(raw).split(',').map(x => x.trim()).filter(Boolean);
    for (const p of parts) {
        const idx = p.indexOf(':');
        if (idx === -1) continue;
        out[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    }
    return out;
};

const readCsv = (filePath) => {
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(parse({ columns: true, skip_empty_lines: true, bom: true }))
            .on('data', row => rows.push(row))
            .on('error', reject)
            .on('end', () => resolve(rows));
    });
};

const detectFileType = (rows) => {
    if (!rows.length) return 'unknown';
    const headers = Object.keys(rows[0]);
    if (headers.includes("Transaction ID")) return "items";
    if (headers.includes("Buyer User ID")) return "orders";
    return "unknown";
};

// ================== SELLER LOGIC ==================
// SKU: "J2512-TS2S-270126-Abuela" => sellerCode = "J2512"
const getSellerCodeFromSku = (sku) => {
    if (!sku) return null;
    const s = String(sku).trim();
    if (!s) return null;
    const first = s.split('-')[0]?.trim();
    if (!first) return null;
    return first;
};

const fillSellerIfMissing = async (orderId, sellerCode) => {
    if (!sellerCode) return;

    // Tìm user theo employee_id
    const user = await User.findOne({ employee_id: sellerCode }).select('_id employee_id').lean();

    const missing = (field) => ({
        $or: [
            { $eq: [{ $ifNull: [field, null] }, null] },
            { $eq: [field, ""] }
        ]
    });

    // Fill-if-missing, không overwrite
    const pipeline = [{
        $set: {
            "seller.sellerCode": {
                $cond: [missing("$seller.sellerCode"), sellerCode, "$seller.sellerCode"]
            },
            "seller.sellerId": user?._id
                ? { $cond: [missing("$seller.sellerId"), user._id, "$seller.sellerId"] }
                : "$seller.sellerId",
        }
    }];

    await EtsyOrder.updateOne({ orderId }, pipeline, { upsert: true });
};

// ================== INTERNAL LOGIC ==================

const fillIfMissingFromItemRow = async (orderId, row) => {

    const missing = (field) => ({
        $or: [
            { $eq: [{ $ifNull: [field, null] }, null] },
            { $eq: [field, ""] }
        ]
    });

    const pipeline = [{
        $set: {
            paidAt: toDate(row["Date Paid"])
                ? { $cond: [missing("$paidAt"), toDate(row["Date Paid"]), "$paidAt"] }
                : "$paidAt",

            "shipping.name": row["Ship Name"]
                ? { $cond: [missing("$shipping.name"), row["Ship Name"], "$shipping.name"] }
                : "$shipping.name",

            "buyer.display": row["Buyer"]
                ? { $cond: [missing("$buyer.display"), row["Buyer"], "$buyer.display"] }
                : "$buyer.display",

            "coupon.code": row["Coupon Code"]
                ? { $cond: [missing("$coupon.code"), row["Coupon Code"], "$coupon.code"] }
                : "$coupon.code",

            "coupon.details": row["Coupon Details"]
                ? { $cond: [missing("$coupon.details"), row["Coupon Details"], "$coupon.details"] }
                : "$coupon.details",

            // Bạn có thể mở rộng các totals khác tương tự nếu muốn
            "totals.orderShipping":
                toNumber(row["Order Shipping"]) !== null
                    ? {
                        $cond: [
                            { $eq: [{ $ifNull: ["$totals.orderShipping", null] }, null] },
                            toNumber(row["Order Shipping"]),
                            "$totals.orderShipping"
                        ]
                    }
                    : "$totals.orderShipping"
        }
    }];

    await EtsyOrder.updateOne({ orderId }, pipeline, { upsert: true });
};

const upsertEmbeddedItem = async (orderId, itemDoc) => {
    // Update nếu đã có transactionId
    const updateExisting = await EtsyOrder.updateOne(
        { orderId, "items.transactionId": itemDoc.transactionId },
        { $set: { "items.$": itemDoc } }
    );

    if (updateExisting.matchedCount > 0) return false;

    // Push nếu chưa có
    await EtsyOrder.updateOne(
        { orderId, "items.transactionId": { $ne: itemDoc.transactionId } },
        { $push: { items: itemDoc } }
    );

    return true;
};

const syncItemCount = async (orderId) => {
    await EtsyOrder.updateOne(
        { orderId },
        [{ $set: { numberOfItems: { $size: { $ifNull: ["$items", []] } } } }]
    );
};

// ================== CONTROLLER ==================

const importOrders = async (req, res) => {
    try {

        if (!req.files?.length) {
            return res.status(400).json({ message: "No files uploaded" });
        }

        const stats = {
            ordersUpserted: 0,
            itemsProcessed: 0,
            itemsCreated: 0,
            sellerLinked: 0
        };

        for (const file of req.files) {

            const rows = await readCsv(file.path);
            const type = detectFileType(rows);

            // ===== ORDER FILE =====
            if (type === "orders") {
                const bulkOps = rows
                    .map(row => row["Order ID"] ? ({
                        updateOne: {
                            filter: { orderId: row["Order ID"] },
                            update: {
                                $setOnInsert: { orderId: row["Order ID"], items: [] },
                                $set: {
                                    saleDate: toDate(row["Sale Date"]),
                                    shippedAt: toDate(row["Date Shipped"]),
                                    status: row["Status"],
                                    currency: row["Currency"],
                                    paymentMethod: row["Payment Method"],

                                    "buyer.userId": row["Buyer User ID"],
                                    "buyer.fullName": row["Full Name"],
                                    "buyer.firstName": row["First Name"],
                                    "buyer.lastName": row["Last Name"],

                                    "shipping.address1": row["Street 1"],
                                    "shipping.address2": row["Street 2"],
                                    "shipping.city": row["Ship City"],
                                    "shipping.state": row["Ship State"],
                                    "shipping.zipcode": row["Ship Zipcode"],
                                    "shipping.country": row["Ship Country"],

                                    "totals.orderValue": toNumber(row["Order Value"]),
                                    "totals.shipping": toNumber(row["Shipping"]),
                                    "totals.salesTax": toNumber(row["Sales Tax"]),
                                    "totals.orderTotal": toNumber(row["Order Total"]),
                                    "totals.cardProcessingFees": toNumber(row["Card Processing Fees"]),
                                    "totals.orderNet": toNumber(row["Order Net"]),

                                    "totals.adjustedOrderTotal": toNumber(row["Adjusted Order Total"]),
                                    "totals.adjustedCardProcessingFees": toNumber(row["Adjusted Card Processing Fees"]),
                                    "totals.adjustedNet": toNumber(row["Adjusted Net"]),
                                    "totals.adjustedOrderValue": toNumber(row["Adjusted Order Value"]),
                                    "totals.adjustedShipping": toNumber(row["Adjusted Shipping"]),
                                    "totals.adjustedSalesTax": toNumber(row["Adjusted Sales Tax"]),

                                    numberOfItems: toInt(row["Number of Items"])
                                }
                            },
                            upsert: true
                        }
                    }) : null)
                    .filter(Boolean);

                if (bulkOps.length) {
                    const result = await EtsyOrder.bulkWrite(bulkOps, { ordered: false });
                    stats.ordersUpserted += (result.modifiedCount || 0) + (result.upsertedCount || 0);
                }
            }

            // ===== ITEM FILE =====
            if (type === "items") {

                const affectedOrders = new Set();

                for (const row of rows) {

                    const orderId = row["Order ID"];
                    if (!orderId) continue;

                    affectedOrders.add(orderId);

                    // ensure order exists
                    await EtsyOrder.updateOne(
                        { orderId },
                        { $setOnInsert: { orderId, items: [] } },
                        { upsert: true }
                    );

                    // fill-if-missing patch from item row
                    await fillIfMissingFromItemRow(orderId, row);

                    // build item
                    const itemDoc = {
                        transactionId: row["Transaction ID"],
                        listingId: row["Listing ID"],
                        sku: row["SKU"],
                        itemName: row["Item Name"],
                        quantity: toInt(row["Quantity"]) ?? 1,
                        unitPrice: toNumber(row["Price"]),
                        itemTotal: toNumber(row["Item Total"]),
                        variationsRaw: row["Variations"],
                        variations: parseVariations(row["Variations"])
                    };

                    // ✅ fill seller from SKU prefix (fill-if-missing)
                    const sellerCode = getSellerCodeFromSku(itemDoc.sku);
                    if (sellerCode) {
                        await fillSellerIfMissing(orderId, sellerCode);
                        stats.sellerLinked += 1; // đếm số row có attempt (không phải số order unique)
                    }

                    // upsert embedded item
                    const created = await upsertEmbeddedItem(orderId, itemDoc);
                    stats.itemsProcessed += 1;
                    if (created) stats.itemsCreated += 1;
                }

                // sync numberOfItems after processing
                for (const oid of affectedOrders) {
                    await syncItemCount(oid);
                }
            }

            fs.unlink(file.path, () => { });
        }

        return res.json({
            message: "Etsy Order import completed (fill-if-missing + seller from SKU)",
            stats
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET /api/etsy-orders
// Query:
//  page, limit, sortBy, sortOrder
//  q, sellerId, sellerCode, status, hasShipped, dateFrom, dateTo, dateField
const getListOrders = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 20,

            sortBy = 'saleDate',     // saleDate | paidAt | shippedAt | createdAt | updatedAt
            sortOrder = 'desc',      // asc | desc

            q,
            sellerId,
            sellerCode,
            status,
            hasShipped,              // "true" | "false"
            dateFrom,
            dateTo,
            dateField = 'saleDate',  // saleDate | paidAt | shippedAt
        } = req.query;

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 20));
        const skip = (pageNum - 1) * limitNum;

        const orderDir = String(sortOrder).toLowerCase() === 'asc' ? 1 : -1;
        const safeSortFields = new Set(['saleDate', 'paidAt', 'shippedAt', 'createdAt', 'updatedAt']);
        const finalSortBy = safeSortFields.has(sortBy) ? sortBy : 'saleDate';

        const sort = { [finalSortBy]: orderDir };

        // ---------------- filter ----------------
        const filter = {};

        if (sellerId) filter['seller.sellerId'] = sellerId;
        if (sellerCode) filter['seller.sellerCode'] = sellerCode;

        if (status !== undefined && status !== null && String(status).trim() !== '') {
            filter.status = String(status).trim();
        }

        if (hasShipped === 'true') filter.shippedAt = { $ne: null };
        if (hasShipped === 'false') filter.shippedAt = null;

        if (dateFrom || dateTo) {
            const from = dateFrom ? new Date(dateFrom) : null;
            const to = dateTo ? new Date(dateTo) : null;

            const field = (dateField === 'paidAt')
                ? 'paidAt'
                : (dateField === 'shippedAt' ? 'shippedAt' : 'saleDate');

            filter[field] = {};
            if (from && !Number.isNaN(from.getTime())) filter[field].$gte = from;
            if (to && !Number.isNaN(to.getTime())) filter[field].$lte = to;

            if (Object.keys(filter[field]).length === 0) delete filter[field];
        }

        // keyword search (orderId, buyer, shipping, coupon, items...)
        if (q && String(q).trim()) {
            const keyword = String(q).trim();
            const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escaped, 'i');

            filter.$or = [
                { orderId: regex },

                // buyer
                { 'buyer.userId': regex },
                { 'buyer.fullName': regex },
                { 'buyer.firstName': regex },
                { 'buyer.lastName': regex },
                { 'buyer.display': regex },

                // seller code (sellerId search handled separately)
                { 'seller.sellerCode': regex },

                // coupon
                { 'coupon.code': regex },
                { 'coupon.details': regex },

                // shipping
                { 'shipping.name': regex },
                { 'shipping.address1': regex },
                { 'shipping.address2': regex },
                { 'shipping.city': regex },
                { 'shipping.state': regex },
                { 'shipping.zipcode': regex },
                { 'shipping.country': regex },

                // items
                { 'items.transactionId': regex },
                { 'items.listingId': regex },
                { 'items.sku': regex },
                { 'items.itemName': regex },

                // classification
                { orderType: regex },
                { listingsType: regex },
                { paymentType: regex },
                { paymentMethod: regex },
                { currency: regex },
                { status: regex },
            ];
        }

        // ---------------- projection ----------------
        // List view: trả đủ field theo schema, items có thể slice để nhẹ
        const projection = {
            orderId: 1,

            saleDate: 1,
            paidAt: 1,
            shippedAt: 1,

            status: 1,

            orderType: 1,
            listingsType: 1,
            paymentType: 1,
            paymentMethod: 1,
            currency: 1,

            buyer: 1,
            seller: 1,

            coupon: 1,
            shipping: 1,
            totals: 1,

            numberOfItems: 1,

            // nếu list dài, nên chỉ preview 3-5 items
            items: { $slice: 5 },

            createdAt: 1,
            updatedAt: 1,
        };

        const query = EtsyOrder.find(filter, projection)
            .sort(sort)
            .skip(skip)
            .limit(limitNum)
            .populate({
                path: 'seller.sellerId',
                select: 'full_name email employee_id team_id role_id', // theo user doc bạn gửi
                options: { lean: true },
            })
            .lean();

        const [total, data] = await Promise.all([
            EtsyOrder.countDocuments(filter),
            query,
        ]);

        const pages = Math.ceil(total / limitNum);

        return res.json({
            page: pageNum,
            limit: limitNum,
            total,
            pages,
            itemsCount: data.length,
            data,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};




module.exports = {
    importOrders,
    getListOrders
};
