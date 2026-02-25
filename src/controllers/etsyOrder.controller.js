const db = require('../models');
const mongoose = require('mongoose');
const EtsyOrder = db.EtsyOrder;
const User = db.user;
const Store = db.shop;

const fs = require('fs');
const { parse } = require('csv-parse');
const axios = require('axios');

/* ================== UTIL ================== */

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

/* ================== SELLER LOGIC (GIỮ NGUYÊN) ================== */

const getSellerCodeFromSku = (sku) => {
    if (!sku) return null;
    const s = String(sku).trim();
    if (!s) return null;
    const first = s.split('-')[0]?.trim();
    if (!first) return null;
    return first;
};

const fillSellerIfMissing = async (orderId, shopId, sellerCode) => {
    if (!sellerCode) return;

    const user = await User.findOne({ employee_id: sellerCode })
        .select('_id employee_id')
        .lean();

    const missing = (field) => ({
        $or: [
            { $eq: [{ $ifNull: [field, null] }, null] },
            { $eq: [field, ""] }
        ]
    });

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

    await EtsyOrder.updateOne({ orderId, shopId }, pipeline, { upsert: true });
};

/* ================== ADDRESS VALIDATION ================== */

const validateAddressWithSmarty = async (address) => {
    try {
        const response = await axios.get(
            "https://us-street.api.smarty.com/street-address",
            {
                timeout: 8000,
                params: {
                    "auth-id": process.env.SMARTY_AUTH_ID,
                    "auth-token": process.env.SMARTY_AUTH_TOKEN,
                    street: address.address,
                    street2: address.address_2,
                    city: address.city,
                    state: address.state,
                    zipcode: address.zip_code,
                },
            }
        );

        const data = response.data;
        if (Array.isArray(data) && data.length > 0) {
            return { isValid: true, smartyResponse: data[0] };
        }

        return { isValid: false, smartyResponse: null };
    } catch (err) {
        return { isValid: false, smartyResponse: { error: err.message } };
    }
};

const validateAddressIfNeeded = async (orderDoc) => {
    if (!orderDoc) return;

    if (
        orderDoc.shipping?.country !== "United States" &&
        orderDoc.shipping?.country !== "US"
    ) return;

    if (
        orderDoc.address_validation?.isValid === null &&
        orderDoc.address_validation?.smartyResponse === null
    ) {
        const result = await validateAddressWithSmarty({
            address: orderDoc.shipping?.address1,
            address_2: orderDoc.shipping?.address2,
            city: orderDoc.shipping?.city,
            state: orderDoc.shipping?.state,
            zip_code: orderDoc.shipping?.zipcode,
        });

        orderDoc.address_validation = result;
        await orderDoc.save();
    }
};

/* ================== CONTROLLER ================== */

const importOrders = async (req, res) => {
    try {

        const { shopId } = req.body;

        if (!shopId || !mongoose.Types.ObjectId.isValid(shopId)) {
            return res.status(400).json({ message: "Valid shopId is required" });
        }

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

            /* ===== ORDER FILE ===== */
            if (type === "orders") {
                const bulkOps = rows
                    .map(row => row["Order ID"] ? ({
                        updateOne: {
                            filter: { orderId: row["Order ID"], shopId },
                            update: {
                                $setOnInsert: { orderId: row["Order ID"], shopId, items: [] },
                                $set: {
                                    saleDate: toDate(row["Sale Date"]),
                                    shippedAt: toDate(row["Date Shipped"]),
                                    status: row["Status"],
                                    currency: row["Currency"],
                                    paymentMethod: row["Payment Method"],

                                    "buyer.userId": row["Buyer User ID"],
                                    "buyer.fullName": row["Full Name"],

                                    "shipping.address1": row["Street 1"],
                                    "shipping.address2": row["Street 2"],
                                    "shipping.city": row["Ship City"],
                                    "shipping.state": row["Ship State"],
                                    "shipping.zipcode": row["Ship Zipcode"],
                                    "shipping.country": row["Ship Country"],
                                }
                            },
                            upsert: true
                        }
                    }) : null)
                    .filter(Boolean);

                if (bulkOps.length) {
                    await EtsyOrder.bulkWrite(bulkOps, { ordered: false });
                }
            }

            /* ===== ITEM FILE ===== */
            if (type === "items") {

                const affectedOrders = new Set();

                for (const row of rows) {

                    const orderId = row["Order ID"];
                    if (!orderId) continue;

                    affectedOrders.add(orderId);

                    await EtsyOrder.updateOne(
                        { orderId, shopId },
                        { $setOnInsert: { orderId, shopId, items: [] } },
                        { upsert: true }
                    );

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

                    const updateExisting = await EtsyOrder.updateOne(
                        { orderId, shopId, "items.transactionId": itemDoc.transactionId },
                        { $set: { "items.$": itemDoc } }
                    );

                    if (updateExisting.matchedCount === 0) {
                        await EtsyOrder.updateOne(
                            { orderId, shopId },
                            { $push: { items: itemDoc } }
                        );
                    }

                    // 🔥 GIỮ NGUYÊN SELLER FLOW
                    const sellerCode = getSellerCodeFromSku(itemDoc.sku);
                    if (sellerCode) {
                        await fillSellerIfMissing(orderId, shopId, sellerCode);
                        stats.sellerLinked += 1;
                    }

                    stats.itemsProcessed += 1;
                }

                for (const oid of affectedOrders) {
                    await EtsyOrder.updateOne(
                        { orderId: oid, shopId },
                        [{ $set: { numberOfItems: { $size: { $ifNull: ["$items", []] } } } }]
                    );

                    const order = await EtsyOrder.findOne({ orderId: oid, shopId });
                    await validateAddressIfNeeded(order);
                }
            }

            fs.unlink(file.path, () => { });
        }

        return res.json({
            message: "Etsy Order import completed (multi-shop + seller preserved)",
            stats
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/* =======================================================
   GET LIST
======================================================= */

const getListOrders = async (req, res) => {
    try {
        const { page = 1, limit = 20, shopId, status, q } = req.query;

        const filter = {};
        if (shopId && mongoose.Types.ObjectId.isValid(shopId))
            filter.shopId = shopId;
        if (status) filter.status = status;

        if (q) {
            const regex = new RegExp(q, "i");
            filter.$or = [
                { orderId: regex },
                { "buyer.fullName": regex },
                { "items.sku": regex },
            ];
        }

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(200, parseInt(limit));
        const skip = (pageNum - 1) * limitNum;

        const [total, data] = await Promise.all([
            EtsyOrder.countDocuments(filter),
            EtsyOrder.find(filter)
                .populate("shopId", "name store merchant")
                .populate("seller.sellerId", "full_name email employee_id")
                .sort({ saleDate: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean(),
        ]);

        return res.json({
            page: pageNum,
            limit: limitNum,
            total,
            pages: Math.ceil(total / limitNum),
            data,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    importOrders,
    getListOrders,
};