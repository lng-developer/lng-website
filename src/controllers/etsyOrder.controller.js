const db = require('../models');
const mongoose = require('mongoose');
const EtsyOrder = db.EtsyOrder;
const EtsyListing = require('../models/etsyListing.model');
const User = db.user;
const Role = db.role;
const Store = db.shop;

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const axios = require('axios');
const multer = require("multer");
const { uploadBufferToR2 } = require("../service/cloudflareR2/r2.service");

const etsyScaleUpload = multer({ storage: multer.memoryStorage() });

/* ================== UTIL ================== */

const toBooleanStrict = (value) => {
    if (value === true || value === false) return value;
    if (String(value).toLowerCase() === "true") return true;
    if (String(value).toLowerCase() === "false") return false;
    return null;
};

const ETSY_TRACKING_STATUSES = ["New", "In progress", "Fulfilled", "Shipping", "Shipped", "Canceled", "Cancelled"];
const isEtsyCanceledStatus = (status) => ["Canceled", "Cancelled"].includes(String(status || "").trim());

function computeEtsyOrderStatusFromItems(items = []) {
    const statuses = (items || []).map((item) => String(item?.tracking_info?.status || "New").trim());
    const active = statuses.filter((status) => !isEtsyCanceledStatus(status));
    if (active.length === 0 && statuses.length > 0) return "Canceled";
    if (active.length > 0 && active.every((status) => status === "Shipped")) return "Shipped";
    if (active.includes("Shipping")) return "Shipping";
    if (active.includes("Fulfilled")) return "Fulfilled";
    if (active.includes("In progress")) return "In progress";
    return "New";
}

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

async function mapOptionValue({ configCode, key, rawValue }) {
    let val = String(rawValue ?? "");
    if (!val) return { value: val, ruleId: null, matchType: null };
    if (!ConfigOptionMapping)
        return { value: val, ruleId: null, matchType: null };

    const rules = await ConfigOptionMapping.find({
        config_code: configCode,
        key,
        active: { $ne: false },
    })
        .sort({ priority: 1, created_at: 1 })
        .lean();

    const n = (x) => String(x || "").trim();
    const nl = (x) => normalize(x);

    for (const r of rules || []) {
        const mt = String(r.match_type || "equals").toLowerCase();
        const flags = r.regex_flags || "i";
        const cs = !!r.case_sensitive;
        const mval = String(r.match_value ?? "");
        const mapped = String(r.mapped_value ?? "");

        try {
            if (mt === "equals") {
                const ok = cs ? n(val) === n(mval) : nl(val) === nl(mval);
                if (ok) return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "contains") {
                const ok = cs ? n(val).includes(n(mval)) : nl(val).includes(nl(mval));
                if (ok) return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "regex") {
                const re = new RegExp(mval, flags);
                if (re.test(val))
                    return { value: mapped, ruleId: String(r._id), matchType: mt };
            }
            if (mt === "regex_replace") {
                const re = new RegExp(mval, flags);
                const replaced = val.replace(re, mapped);
                if (replaced !== val)
                    return { value: replaced, ruleId: String(r._id), matchType: mt };
            }
        } catch (_e) {
            /* ignore */
        }
    }
    return { value: val, ruleId: null, matchType: null };
}

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
                    .map(row => {
                        if (!row["Order ID"]) return null;

                        const orderValue = toNumber(row["Order Value"]) || 0;
                        const shipping = toNumber(row["Shipping"]) || 0;
                        const orderTotal = toNumber(row["Order Total"]) || 0;
                        const discountAmount = toNumber(row["Discount Amount"]) || 0;
                        const cardProcessingFees = toNumber(row["Card Processing Fees"]) || 0;
                        const orderNet = toNumber(row["Order Net"]) || 0;

                        let salesTax = toNumber(row["Sales Tax"]) || 0;

                        // Recalculate Sales Tax if 0 (Etsy Marketplace Facilitator Tax scenario)
                        // Formula: Order Total = Order Value + Shipping + Sales Tax - Discount Amount
                        if (salesTax === 0 && orderTotal > 0) {
                            const computedTax = orderTotal - (orderValue + shipping - discountAmount);
                            if (computedTax > 0) {
                                salesTax = Number(computedTax.toFixed(2));
                            }
                        }

                        // Tính FEE theo công thức đặc thù VN:
                        // 1. 6.5% of ordertotal (excluding tax)
                        // 2. 4.5% of ordertotal + 11500vnd (quy đổi USD)
                        // 3. 1.24% of ordertotal (excluding tax)
                        const orderTotalExcludingTax = orderTotal - salesTax;
                        const exchangeRate = 26000; // Tỷ giá giả định 26,000 VND = 1 USD
                        const fixedFeeUsd = 11500 / exchangeRate;

                        const calculatedFee =
                            (0.065 * orderTotalExcludingTax) +
                            (0.045 * orderTotal + fixedFeeUsd) +
                            (0.0124 * orderTotalExcludingTax);

                        return {
                            updateOne: {
                                filter: { orderId: row["Order ID"], shopId },
                                update: {
                                    $setOnInsert: { orderId: row["Order ID"], shopId, items: [] },
                                    $set: {
                                        saleDate: toDate(row["Sale Date"]),
                                        shippedAt: toDate(row["Date Shipped"]),
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

                                        "totals.orderValue": orderValue,
                                        "totals.shipping": shipping,
                                        "totals.salesTax": salesTax,
                                        "totals.orderTotal": orderTotal,
                                        "totals.fee": Number(calculatedFee.toFixed(2)),
                                        "totals.cardProcessingFees": cardProcessingFees,
                                        "totals.orderNet": orderNet,
                                        "totals.discountAmount": discountAmount
                                    }
                                },
                                upsert: true
                            }
                        };
                    })
                    .filter(Boolean);

                if (bulkOps.length) {
                    await EtsyOrder.bulkWrite(bulkOps, { ordered: false });
                }
            }

            /* ===== ITEM FILE ===== */
            if (type === "items") {

                const affectedOrders = new Set();
                let computedCount = 0;

                // 🔥 Batch lookup: lấy tất cả SKU → tìm IMAGE1 từ etsylistings
                const allSkus = rows
                    .map(r => r["SKU"])
                    .filter(Boolean);
                const uniqueSkus = [...new Set(allSkus)];
                const listings = await EtsyListing.find({ SKU: { $in: uniqueSkus } }).lean();
                const skuImageMap = new Map();
                for (const listing of listings) {
                    if (listing.SKU && listing.IMAGE1) {
                        skuImageMap.set(listing.SKU, listing.IMAGE1);
                    }
                }

                for (const row of rows) {

                    const orderId = row["Order ID"];
                    if (!orderId) continue;

                    affectedOrders.add(orderId);

                    await EtsyOrder.updateOne(
                        { orderId, shopId },
                        { $setOnInsert: { orderId, shopId, items: [] } },
                        { upsert: true }
                    );

                    const itemSku = row["SKU"];
                    const baseImageUrl = skuImageMap.get(itemSku) || null;

                    const itemDoc = {
                        transactionId: row["Transaction ID"],
                        listingId: row["Listing ID"],
                        sku: itemSku,
                        itemName: row["Item Name"],
                        quantity: toInt(row["Quantity"]) ?? 1,
                        unitPrice: toNumber(row["Price"]),
                        itemTotal: toNumber(row["Item Total"]),
                        variationsRaw: row["Variations"],
                        variations: parseVariations(row["Variations"]),
                        baseImage: baseImageUrl ? { imageUrl: baseImageUrl } : undefined,
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

                    try {
                        // Tự động tính toán cost breakdown sau khi import
                        if (order && Array.isArray(order.items) && order.items.length > 0) {
                            await calculateEtsyCost(order);
                            computedCount++;
                        }
                    } catch (err) {
                        console.error(`Auto-compute cost failed for Etsy order ${oid}:`, err.message);
                    }
                }

                stats.ordersCostComputed = computedCount;
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
        const {
            page = 1,
            limit = 20,
            from,
            to,
            search,
            platform,
            userNull,
            noPsd,
            shippingType,
            shopName,
            teamId,
            openCase,
            status,
            isNoCostCenter,
            sortBy = "saleDate",
            sortOrder = "desc",
        } = req.query;

        const filter = {};

        // ===== Filters cơ bản =====
        if (status) filter.status = status;
        if (shippingType) filter.shipping_type = shippingType;

        // ===== Shop name filter =====
        if (shopName) {
            const shops = await Store.find({ name: new RegExp(shopName, "i") }).select("_id").lean();
            const shopIds = shops.map(s => s._id);
            filter.shopId = { $in: shopIds };
        }

        // ===== Team filter =====
        if (teamId) {
            const teamShops = await Store.find({ team: teamId }).select("_id").lean();
            const teamShopIds = teamShops.map(s => s._id);
            if (filter.shopId) {
                // Intersect with shopName filter nếu có
                const existing = filter.shopId.$in || [filter.shopId];
                filter.shopId = { $in: existing.filter(id => teamShopIds.some(tid => tid.equals(id))) };
            } else {
                filter.shopId = { $in: teamShopIds };
            }
        }

        // ===== User null (orders chưa có seller) =====
        if (userNull === "true") {
            filter["seller.sellerId"] = { $in: [null, undefined] };
        }

        // ===== Date range (saleDate) =====
        if (from || to) {
            filter.saleDate = {};
            if (from) filter.saleDate.$gte = new Date(from);
            if (to) filter.saleDate.$lte = new Date(to);
        }

        // ===== isNoCostCenter: đơn chưa có base_cost =====
        if (isNoCostCenter === "true") {
            filter.$and = [
                ...(filter.$and || []),
                {
                    $or: [
                        { base_cost: { $exists: false } },
                        { base_cost: null },
                        { base_cost: 0 },
                    ],
                },
                { status: { $ne: "Cancelled" } },
            ];
        }

        // ===== Full-text search =====
        if (search) {
            const regex = new RegExp(search, "i");
            const searchOr = [
                { orderId: regex },
                { "buyer.fullName": regex },
                { "buyer.userId": regex },
                { "items.sku": regex },
                { "items.itemName": regex },
                { "items.transactionId": regex },
                { "seller.sellerCode": regex },
                { "shipping.city": regex },
                { "shipping.state": regex },
                { "shipping.country": regex },
            ];
            filter.$or = searchOr;
        }

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(200, parseInt(limit));
        const skip = (pageNum - 1) * limitNum;

        // ===== Sort =====
        const allowedSortFields = ["saleDate", "createdAt", "updatedAt", "base_cost", "numberOfItems", "orderId", "status"];
        const sortField = allowedSortFields.includes(sortBy) ? sortBy : "saleDate";
        const sortDir = sortOrder === "asc" ? 1 : -1;

        const [total, rawData] = await Promise.all([
            EtsyOrder.countDocuments(filter),
            EtsyOrder.find(filter)
                .populate("shopId", "name store merchant")
                .populate("seller.sellerId", "full_name email employee_id")
                .sort({ [sortField]: sortDir })
                .skip(skip)
                .limit(limitNum)
                .lean(),
        ]);

        // ===== Collect vendorProductIds for cost_center =====
        const vpIdSet = new Set();
        for (const order of rawData) {
            for (const item of (order.items || [])) {
                if (item.cost_breakdown?.vendorProductId) {
                    vpIdSet.add(item.cost_breakdown.vendorProductId);
                }
            }
        }

        // Batch lookup VendorProduct + Vendor
        const vpMap = new Map(); // vendorProductId -> { vendorProductDisplayName, ... }
        if (vpIdSet.size > 0) {
            const VendorProduct = db.vendorProduct;
            const Vendor = db.vendor;
            const vpDocs = await VendorProduct.find({ _id: { $in: [...vpIdSet] } }).lean();
            const vendorIds = [...new Set(vpDocs.map(vp => String(vp.vendor_id)))];
            const vendorDocs = await Vendor.find({ _id: { $in: vendorIds } }).lean();
            const vendorMap = new Map(vendorDocs.map(v => [String(v._id), v.name]));

            for (const vp of vpDocs) {
                const vendorName = vendorMap.get(String(vp.vendor_id)) || "Unknown";
                vpMap.set(String(vp._id), {
                    vendorProductId: String(vp._id),
                    vendorProductDisplayName: `${vendorName} - ${vp.product_name || ""}`,
                });
            }
        }

        // ===== Transform data =====
        const data = rawData.map((order) => {
            const shop = order.shopId || {};
            const sellerPopulated = order.seller?.sellerId || null;

            return {
                orderId: order.orderId,
                customer_infor: {
                    name: order.buyer?.fullName || order.shipping?.name || "",
                    address: order.shipping?.address1 || "",
                    address_2: order.shipping?.address2 || "",
                    city: order.shipping?.city || "",
                    state: order.shipping?.state || "",
                    zip_code: order.shipping?.zipcode || "",
                    country: order.shipping?.country || "",
                },
                status: order.status || "New",
                purchase_date: order.saleDate || null,
                createdAt: order.createdAt || null,
                shopId: shop._id ? String(shop._id) : String(order.shopId || ""),
                shopName: shop.name || "",
                shipping_type: order.shipping_type || "Standard",
                items: (order.items || []).map((item) => {
                    // Build cost_center
                    let cost_center = null;
                    if (item.cost_breakdown?.vendorProductId) {
                        const vpInfo = vpMap.get(String(item.cost_breakdown.vendorProductId));
                        cost_center = {
                            vendorProductId: item.cost_breakdown.vendorProductId,
                            vendorProductDisplayName: vpInfo?.vendorProductDisplayName || "",
                            sizeValue: item.cost_breakdown.sizeValue || null,
                            colorValue: item.cost_breakdown.colorValue || null,
                        };
                    }

                    // Build version3Data from variations
                    let version3Data = null;
                    if (item.variations && typeof item.variations === "object") {
                        version3Data = Object.entries(item.variations).map(([label, value]) => ({
                            label,
                            value: value || "",
                        }));
                    }

                    return {
                        orderItemId: item.transactionId || "",
                        sku: item.sku || "",
                        title: item.itemName || "",
                        quantity: item.quantity || 1,
                        version3Data,
                        baseImageUrl: item.baseImage?.imageUrl || "",
                        listingId: item.listingId || null,
                        cost_center,
                        tracking_info: item.tracking_info || {},
                        scale_status: item.scale_status || null,
                    };
                }),
                base_cost: order.base_cost || 0,
                sumbittedoetsy: order.sumbittedoetsy ?? false,
                address_validation: order.address_validation?.isValid ?? null,
                seller: sellerPopulated ? {
                    _id: sellerPopulated._id,
                    full_name: sellerPopulated.full_name,
                    email: sellerPopulated.email,
                } : null,
                numberOfItems: order.numberOfItems || 0,
            };
        });

        return res.json({
            data,
            totalCount: total,
            totalPages: Math.ceil(total / limitNum),
            currentPage: pageNum,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

/* ================== COMPUTE BASE COST LOGIC ================== */

const ConfigCostCenter = db.configCostCenter;
const VendorCostCenter = db.vendorCostCenter;
const ConfigOptionMapping = db.configOptionMapping;
const VendorProduct = db.vendorProduct;

function parseConfigCodeFromSKU(sku = "") {
    const parts = String(sku).split("-").map((s) => s.trim()).filter(Boolean);
    return parts.length >= 2 ? parts[1] : "";
}

function normalize(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function toArray(val) {
    if (Array.isArray(val)) return val;
    if (val == null) return [];
    return [val];
}

function pickValueByKeys(labelValueMap, keys = []) {
    for (const k of toArray(keys)) {
        const v = labelValueMap.get(normalize(k));
        if (v != null && v !== "") return v;
    }
    return "";
}

function extractLabelValueMapFromEtsyItem(item) {
    const map = new Map();
    const vars = item?.variations || {};
    for (const [label, value] of Object.entries(vars)) {
        if (!label) continue;
        const normLabel = normalize(label);
        map.set(normLabel, String(value || ""));
        if (normLabel === "style - size" && value) {
            const lastDash = String(value).lastIndexOf(" - ");
            if (lastDash > 0) {
                const stylePart = String(value).substring(0, lastDash).trim();
                const sizePart = String(value).substring(lastDash + 3).trim();
                if (!map.has("style")) map.set("style", stylePart);
                if (!map.has("size")) map.set("size", sizePart);
                if (!map.has("product type")) map.set("product type", stylePart);
            }
        }
    }
    return map;
}

async function selectConfigByProductType(configCode, labelValueMap, mapOptionValue = null) {
    const cfgCandidates = await ConfigCostCenter.find({
        config_code: configCode,
        is_deleted: { $in: [false, null] },
    })
        .populate("product_for_seller")
        .lean();

    if (!cfgCandidates.length)
        return { cfg: null, reason: "No config cost center found by config_code" };

    let mappedProductTypeInfo = null;

    for (const c of cfgCandidates) {
        let typeValRaw = pickValueByKeys(labelValueMap, c.customize_product_type_key || []);

        // Etsy fallback: nếu không tìm thấy key "Select Product Type", thử lấy "product type" 
        if (!typeValRaw && labelValueMap.has("product type")) {
            typeValRaw = labelValueMap.get("product type");
        }

        let typeValToMatch = normalize(typeValRaw);

        // Thử mapping biến thể kiểu product type nếu có mapOptionValue
        if (typeValRaw && mapOptionValue && !mappedProductTypeInfo) {
            mappedProductTypeInfo = await mapOptionValue({ configCode, key: "product type", rawValue: typeValRaw });
        }

        if (mappedProductTypeInfo && mappedProductTypeInfo.value && normalize(mappedProductTypeInfo.value) !== typeValToMatch) {
            typeValToMatch = normalize(mappedProductTypeInfo.value);
        }

        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeValToMatch && sellerName && typeValToMatch === sellerName) {
            return { cfg: c, productTypeValue: typeValRaw, matchedBy: mappedProductTypeInfo?.matchType ? "product_type_mapped" : "product_type_exact" };
        }
    }

    if (cfgCandidates.length === 1) {
        const only = cfgCandidates[0];
        const typeValRaw = pickValueByKeys(labelValueMap, only.customize_product_type_key || []);
        return { cfg: only, productTypeValue: typeValRaw, matchedBy: "single_candidate_fallback" };
    }

    // Fallback: partial match
    const partialMatches = [];
    for (const c of cfgCandidates) {
        const typeValRaw = pickValueByKeys(labelValueMap, c.customize_product_type_key || []);
        const typeVal = normalize(typeValRaw);
        const sellerName = normalize(c?.product_for_seller?.name || "");
        if (typeVal && sellerName && sellerName.includes(typeVal)) {
            partialMatches.push({ cfg: c, typeValRaw });
        }
    }

    if (partialMatches.length === 1) {
        return {
            cfg: partialMatches[0].cfg,
            productTypeValue: partialMatches[0].typeValRaw,
            matchedBy: "product_type_partial_match",
        };
    }

    return { cfg: null, reason: `Multiple configs (${cfgCandidates.length}) - partial matches (${partialMatches.length}); cannot determine by product type key/value` };
}

async function mapOptionValue({ configCode, key, rawValue }) {
    let val = String(rawValue ?? "");
    if (!val) return { value: val, ruleId: null, matchType: null };
    const rules = await ConfigOptionMapping.find({ config_code: configCode, key, active: { $ne: false } })
        .sort({ priority: 1, created_at: 1 }).lean();
    const nl = (x) => normalize(x);
    const n = (x) => String(x || "").trim();
    for (const r of rules || []) {
        const mt = String(r.match_type || "equals").toLowerCase();
        const flags = r.regex_flags || "i";
        const cs = !!r.case_sensitive;
        const mval = String(r.match_value ?? ""); const mapped = String(r.mapped_value ?? "");

        try {
            if (mt === "equals") { if (cs ? n(val) === n(mval) : nl(val) === nl(mval)) return { value: mapped, ruleId: String(r._id), matchType: mt }; }
            if (mt === "contains") { if (cs ? n(val).includes(n(mval)) : nl(val).includes(nl(mval))) return { value: mapped, ruleId: String(r._id), matchType: mt }; }
            if (mt === "regex") { if (new RegExp(mval, flags).test(val)) return { value: mapped, ruleId: String(r._id), matchType: mt }; }
            if (mt === "regex_replace") { const replaced = val.replace(new RegExp(mval, flags), mapped); if (replaced !== val) return { value: replaced, ruleId: String(r._id), matchType: mt }; }
        } catch (_e) { }
    }
    return { value: val, ruleId: null, matchType: null };
}

function findBestCostCenter(candidates, sizeValue, colorValue, { strict = true } = {}) {
    const norm = (s) => String(s || "").toLowerCase().trim();
    const hit = candidates.find((c) => norm(c.vendor_size) === norm(sizeValue) && norm(c.vendor_color) === norm(colorValue));
    if (hit) return hit;
    if (strict) return null;
    return null;
}

async function getVendorIdByVendorProductId(vpId) {
    const vp = await VendorProduct.findById(vpId).select("vendor_id").lean();
    return vp?.vendor_id ? String(vp.vendor_id) : null;
}

function choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) {
    if (!candidateSetsPerItem.length) return null;
    let inter = new Set(candidateSetsPerItem[0]);
    for (let i = 1; i < candidateSetsPerItem.length; i++) {
        inter = new Set([...inter].filter((v) => candidateSetsPerItem[i].has(v)));
        if (inter.size === 0) break;
    }
    if (!inter.size) return null;
    let best = null, bestRank = Infinity;
    for (const vId of inter) {
        const r = vendorRank.get(String(vId)) ?? 999;
        if (r < bestRank || (r === bestRank && String(vId) < String(best))) { best = vId; bestRank = r; }
    }
    return best;
}

async function calculateEtsyCost(order) {
    // ===== QUERY CACHE =====
    const _cfgCache = new Map(), _optCache = new Map(), _vpIdCache = new Map(), _vccCache = new Map();
    const cachedMapOption = async (o) => { const k = `${o.configCode}::${o.key}::${o.rawValue}`; if (_optCache.has(k)) return _optCache.get(k); const r = await mapOptionValue(o); _optCache.set(k, r); return r; };
    const cachedSelectConfig = async (cc, lvm) => { if (_cfgCache.has(cc)) return _cfgCache.get(cc); const r = await selectConfigByProductType(cc, lvm, cachedMapOption); _cfgCache.set(cc, r); return r; };
    const cachedVendorId = async (vpId) => { const k = String(vpId); if (_vpIdCache.has(k)) return _vpIdCache.get(k); const r = await getVendorIdByVendorProductId(vpId); _vpIdCache.set(k, r); return r; };
    const cachedVCC = async (vpId) => { const k = String(vpId); if (_vccCache.has(k)) return _vccCache.get(k); const docs = await VendorCostCenter.find({ vendor_product: vpId, status: { $in: ["Active", "active", null] } }).select("vendor_size vendor_color standard_size standard_color base_cost sku international priority additional_costs").lean(); _vccCache.set(k, docs); return docs; };

    // ===== helper: sku audit (giống Amazon version) =====
    function getSkuForCost(item) {
        const originalSku = (item?.sku || "").trim() || null;
        const mappedSku = (item?.mapped_sku || "").trim() || null;
        const usedSku = mappedSku || originalSku; // ưu tiên mapped_sku
        return { originalSku, mappedSku, usedSku };
    }

    // ===== PASS 1: Pre-scan =====
    const stagedItems = [], preItems = [], candidateSetsPerItem = [];

    for (const item of order.items) {
        const itemId = item.transactionId;
        const { originalSku, mappedSku, usedSku } = getSkuForCost(item);

        const configCode = parseConfigCodeFromSKU(usedSku);
        if (!configCode) { stagedItems.push({ transactionId: itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, status: "failed", reason: "Cannot parse config code" }); continue; }

        if (item.manual_vendor_cost_center_id) {
            const vcc = await VendorCostCenter.findById(item.manual_vendor_cost_center_id).lean();
            if (vcc && Number(vcc.base_cost || 0) > 0) {
                const vId = await cachedVendorId(vcc.vendor_product);
                preItems.push({
                    item,
                    itemId,
                    sku: originalSku,
                    mapped_sku: mappedSku,
                    used_sku: usedSku,
                    configCode,
                    productTypeValue: null,
                    matchedBy: "manual",
                    sizeValue: vcc.vendor_size,
                    colorValue: vcc.vendor_color,
                    manualVcc: vcc,
                    vendorId: vId,
                });
                candidateSetsPerItem.push(new Set(vId ? [vId] : []));
                continue;
            }
            console.warn(`[calculateEtsyCost] Manual VCC ${item.manual_vendor_cost_center_id} not found or has 0 cost. Falling back to auto.`);
        }

        const labelValueMap = extractLabelValueMapFromEtsyItem(item);
        const { cfg, productTypeValue, matchedBy, reason: cfgReason } = await cachedSelectConfig(configCode, labelValueMap);

        if (!cfg) { stagedItems.push({ transactionId: itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, status: "failed", reason: cfgReason }); continue; }

        const sizeRaw = pickValueByKeys(labelValueMap, cfg.customize_size_key || []);
        const colorRaw = pickValueByKeys(labelValueMap, cfg.customize_color_key || []);
        // mapOptionValue: convert size/color raw → vendor-compatible value
        const sizeMap = await cachedMapOption({ configCode, key: "size", rawValue: sizeRaw });
        const colorMap = await cachedMapOption({ configCode, key: "color", rawValue: colorRaw });

        let pfItems = toArray(cfg?.product_for_seller?.items).filter(Boolean);
        if (!pfItems.length) { stagedItems.push({ transactionId: itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, status: "failed", reason: "No pfItems" }); continue; }

        if (["EBM", "EBMA"].includes(configCode.toUpperCase())) {
            const activeItems = pfItems.filter((x) => (x?.status || "").toLowerCase() === "active");
            const fifth = activeItems.find((x) => Number(x.order) === 5);
            if (fifth) pfItems = [fifth];
            else { const sorted = [...activeItems].sort((a, b) => Number(a.order) - Number(b.order)); pfItems = sorted.length >= 5 ? [sorted[4]] : pfItems; }
        }

        preItems.push({ item, itemId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, productTypeValue, matchedBy, sizeValue: sizeMap.value, colorValue: colorMap.value, pfItems });

        const vendorSet = new Set();
        for (const pf of pfItems) {
            const vpId = pf?.vendor_product; if (!vpId) continue;
            const candidates = await cachedVCC(vpId);
            const hit = findBestCostCenter(candidates, sizeMap.value, colorMap.value, { strict: true });
            if (!hit) continue;
            const vId = String(pf?.vendor_id || pf?.vendor?._id || (await cachedVendorId(vpId)) || "");
            if (vId) vendorSet.add(vId);
        }
        candidateSetsPerItem.push(vendorSet);
    }

    let preferredVendorId = order.forced_vendor_id ? String(order.forced_vendor_id) : null;
    if (preItems.length >= 2) {
        const vendorRank = new Map();
        for (const pre of preItems) {
            if (pre.manualVcc) continue;
            for (const it of toArray(pre.pfItems)) { const vpId = it?.vendor_product; if (!vpId) continue; const vId = String(it?.vendor_id || it?.vendor?._id || (await cachedVendorId(vpId)) || ""); if (!vId) continue; vendorRank.set(vId, Math.min(vendorRank.get(vId) ?? 999, it.order ?? 999)); }
        }
        if (!preferredVendorId) {
            preferredVendorId = choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) || null;
        }
    }

    // ===== PASS 2: Detailed calculation =====
    const groups = new Map();
    for (const pre of preItems) {
        const { item, itemId, sku, mapped_sku, used_sku, configCode, productTypeValue, matchedBy, sizeValue, colorValue } = pre;
        const { pfItems } = pre;

        const vendorSelection = await (async () => {
            if (pre.manualVcc) {
                return {
                    success: true,
                    vendorProductId: pre.manualVcc.vendor_product,
                    matched: pre.manualVcc,
                    selectedOrder: -1,
                    itemDisplayName: "Manual Selection",
                    vendorId: pre.vendorId,
                };
            }

            const byOrder = (a, b) => (a.order || 999) - (b.order || 999);
            const actives = pfItems.filter((it) => String(it.status || "").toLowerCase() === "active").sort(byOrder);
            let itemsToCheck = actives.length ? actives : [...pfItems].sort(byOrder);
            const resolved = [];
            for (const it of itemsToCheck) { const vpId = it?.vendor_product; if (!vpId) continue; const vId = String(it?.vendor_id || it?.vendor?._id || (await cachedVendorId(vpId)) || ""); resolved.push({ ...it, __vendorId: vId, __vendorProductId: vpId }); }
            const filtered = preferredVendorId ? resolved.filter((x) => x.__vendorId && String(x.__vendorId) === String(preferredVendorId)) : resolved;
            if (preferredVendorId && filtered.length === 0) return { success: false, reason: `No pfItems under vendor ${preferredVendorId}` };
            const checkList = filtered.length ? filtered : resolved;
            for (const cItem of checkList) {
                const candidates = await cachedVCC(cItem.__vendorProductId); if (!candidates?.length) continue;
                let hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: true });
                if (!hit) hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: false });
                if (hit && Number(hit?.base_cost || 0) > 0) return { success: true, vendorProductId: cItem.__vendorProductId, matched: hit, selectedOrder: cItem.order || 999, itemDisplayName: cItem.display_name || "Unknown", vendorId: cItem.__vendorId };
            }
            return { success: false, reason: "No matching vendor product" };
        })();

        if (!vendorSelection.success) { stagedItems.push({ transactionId: itemId, sku, mapped_sku, used_sku, configCode, sizeValue, colorValue, status: "failed", reason: vendorSelection.reason }); continue; }

        const { vendorProductId, matched, selectedOrder, itemDisplayName, vendorId } = vendorSelection;
        const baseEach = Number(matched?.base_cost || 0) + 1; // +1$ per item surcharge
        const qty = Math.max(1, Number(item.quantity || 1));

        const rate = await (async () => {
            const pickFromDoc = (doc, pp) => { if (!doc) return null; const hp = doc.priority && (doc.priority.economy != null || doc.priority.additional != null); const hi = doc.international && (doc.international.economy != null || doc.international.additional != null); if (pp === "priority" && hp) return { eco: Number(doc.priority.economy ?? 0), add: Number(doc.priority.additional ?? 0), profile: "priority" }; if (hi) return { eco: Number(doc.international.economy ?? 0), add: Number(doc.international.additional ?? 0), profile: "international" }; return null; };
            if (matched?.international && (matched.international.economy != null || matched.international.additional != null))
                return { eco: Number(matched.international.economy ?? 0), add: Number(matched.international.additional ?? 0), profile: "international" };
            const allDocs = await cachedVCC(vendorProductId);
            for (const doc of allDocs) { const p = pickFromDoc(doc, "international"); if (p) return p; }
            return { eco: 0, add: 0, profile: "international" };
        })();

        const additionalCosts = { embroidery: 0, two_sided_print: 0, two_position_print: 0 };
        if (["TSB"].includes(configCode.toUpperCase())) additionalCosts.two_sided_print = Number(matched?.additional_costs?.two_sided_print || 0);
        if (["TS2S"].includes(configCode.toUpperCase())) additionalCosts.two_position_print = Number(matched?.additional_costs?.two_position_print || 0);
        if (["EBM", "EBMA"].includes(configCode.toUpperCase())) additionalCosts.embroidery = Number(matched?.additional_costs?.embroidery || 0);
        const totalAdditionalCost = additionalCosts.embroidery + additionalCosts.two_sided_print + additionalCosts.two_position_print;

        const rec = { transactionId: itemId, sku, mapped_sku, used_sku, configCode, productTypeValue: productTypeValue || null, selectedConfigBy: matchedBy || "unknown", sizeValue, colorValue, vendorProductId, vendorId, selectedOrder, itemDisplayName, baseEach, qty, eco: rate.eco, add: rate.add, shipProfile: rate.profile, matchedSku: matched?.sku || null, additionalCosts, totalAdditionalCost, status: "ok" };
        stagedItems.push(rec);
        const key = `${vendorId}::profile=${rate.profile}::eco=${rate.eco}::add=${rate.add}`;
        const g = groups.get(key) || { vendorId, shipProfile: rate.profile, items: [], economyMax: 0 };
        g.items.push({ ...rec }); g.economyMax = Math.max(g.economyMax, rate.eco); groups.set(key, g);
    }

    // ===== Tổng hợp =====
    const perItemResults = [];
    const groupBreakdowns = [];
    for (const rec of stagedItems) {
        if (rec.status !== "ok") { perItemResults.push(rec); continue; }
        perItemResults.push({
            transactionId: rec.transactionId, sku: rec.sku, configCode: rec.configCode, sizeValue: rec.sizeValue, colorValue: rec.colorValue, productTypeValue: rec.productTypeValue, selectedConfigBy: rec.selectedConfigBy,
            vendorProductId: rec.vendorProductId, vendorId: rec.vendorId, matchedSku: rec.matchedSku, selectedOrder: rec.selectedOrder, itemDisplayName: rec.itemDisplayName,
            base_cost_each: rec.baseEach, quantity: rec.qty,
            additional_costs_breakdown: rec.additionalCosts, total_additional_cost_per_item: rec.totalAdditionalCost * rec.qty,
            shipping_international_economy: 0, shipping_international_additional_units: 0, shipping_international_additional_rate: 0,
            base_cost_total_for_item_including_shipping: rec.baseEach * rec.qty + rec.totalAdditionalCost * rec.qty,
            status: "ok",
        });
    }

    // Phân bổ shipping
    for (const [, g] of groups.entries()) {
        const totalQtyProfile = g.items.reduce((s, it) => s + it.qty, 0);
        if (totalQtyProfile <= 0) continue;
        const ecoOnce = g.economyMax;
        let remainEco = 1, remainAdd = Math.max(0, totalQtyProfile - 1);
        const sorted = [...g.items].sort((a, b) => b.eco - a.eco);
        for (const it of sorted) {
            const out = perItemResults.find((r) => r.transactionId === it.transactionId && r.status === "ok"); if (!out) continue;
            let ecoHere = 0;
            if (remainEco > 0 && it.qty > 0) { ecoHere = ecoOnce; remainEco = 0; }
            let addUnits = it.qty - (ecoHere > 0 ? 1 : 0);
            addUnits = Math.max(0, Math.min(addUnits, remainAdd)); remainAdd -= addUnits;
            out.shipping_international_economy += ecoHere;
            out.shipping_international_additional_units += addUnits;
            out.shipping_international_additional_rate = it.add;
            out.base_cost_total_for_item_including_shipping = Number((out.base_cost_total_for_item_including_shipping + ecoHere + addUnits * it.add).toFixed(2));
            out.formula = `(base ${it.baseEach} * qty ${it.qty}) + add_cost ${it.totalAdditionalCost} * qty ${it.qty} + [${g.shipProfile}] eco ${ecoHere} + add ${it.add} * ${addUnits}`;
        }
        groupBreakdowns.push({ vendor_id: g.vendorId, total_qty: totalQtyProfile, shipping_profile: g.shipProfile, shipping_economy_once: ecoOnce });
    }

    let total = 0;
    for (const r of perItemResults) if (r.status === "ok") total += r.base_cost_total_for_item_including_shipping;

    // ===== LƯU VÀO DATABASE MONGODB BẰNG BULK WRITE - BỎ QUA GỐC MONGOOSE ARRAY MAPPING LỖI =====
    if (order._id) {
        const itemBulkOps = [];
        for (const out of perItemResults) {
            if (out.status !== "ok") continue;

            itemBulkOps.push({
                updateOne: {
                    filter: { _id: order._id, "items.transactionId": out.transactionId },
                    update: {
                        $set: {
                            "items.$.cost_breakdown": {
                                configCode: out.configCode,
                                productTypeValue: out.productTypeValue || "Unknown",
                                selectedConfigBy: out.selectedConfigBy || "Unknown",
                                sizeValue: out.sizeValue || "",
                                colorValue: out.colorValue || "",
                                vendorProductId: out.vendorProductId || "",
                                matchedSku: out.matchedSku || "",
                                selectedOrder: out.selectedOrder || 1,
                                itemDisplayName: out.itemDisplayName || "",
                                base_cost_each: out.base_cost_each || 0,
                                quantity: out.quantity || 1,
                                additional_costs_breakdown: {
                                    embroidery: out.additional_costs_breakdown?.embroidery || 0,
                                    two_sided_print: out.additional_costs_breakdown?.two_sided_print || 0,
                                    two_position_print: out.additional_costs_breakdown?.two_position_print || 0
                                },
                                total_additional_cost_per_item: out.total_additional_cost_per_item || 0,
                                shipping_international_economy: out.shipping_international_economy || 0,
                                shipping_international_additional_units: out.shipping_international_additional_units || 0,
                                shipping_international_additional_rate: out.shipping_international_additional_rate || 0,
                                base_cost_total_for_item_including_shipping: out.base_cost_total_for_item_including_shipping || 0,
                                formula: out.formula || ""
                            }
                        }
                    }
                }
            });
        }

        if (itemBulkOps.length > 0) {
            console.log(`[calculateEtsyCost] BulkWrite: ${itemBulkOps.length} ops for order._id=${order._id}`);
            console.log(`[calculateEtsyCost] Sample filter:`, JSON.stringify(itemBulkOps[0].updateOne.filter));
            const bulkResult = await EtsyOrder.bulkWrite(itemBulkOps);
            console.log(`[calculateEtsyCost] BulkWrite result:`, JSON.stringify({
                matchedCount: bulkResult.matchedCount,
                modifiedCount: bulkResult.modifiedCount,
                upsertedCount: bulkResult.upsertedCount
            }));
        } else {
            console.log(`[calculateEtsyCost] NO bulkWrite ops - all items failed calculation`);
        }

        order.base_cost = Number(total.toFixed(2));
        order.base_cost_shipping_groups = groupBreakdowns;
        order.base_cost_computed_at = new Date();

        await EtsyOrder.updateOne(
            { _id: order._id },
            {
                $set: {
                    base_cost: order.base_cost,
                    base_cost_shipping_groups: order.base_cost_shipping_groups,
                    base_cost_computed_at: order.base_cost_computed_at
                }
            }
        );
    }

    return {
        preferredVendorId,
        groupBreakdowns,
        perItemResults,
    };
}

const computeBaseCostForEtsyOrder = async (req, res) => {
    try {
        const { orderId, orderData } = req.body;
        if (!orderId) return res.status(400).json({ message: "Missing orderId" });

        // Sử dụng document gốc để có thể save() đoạn sau
        let order = await EtsyOrder.findOne({ orderId });

        // Nếu không tìm thấy Order nhưng có truyền JSON data -> Tạo order mới
        if (!order) {
            if (!orderData || typeof orderData !== "object") {
                return res.status(404).json({ message: "Etsy order not found in DB. Provide 'orderData' object to auto-import." });
            }

            // Gắn cứng orderId từ data truyền vào để tránh lỗi lệch
            orderData.orderId = orderId;

            // Nếu dữ liệu thiếu shopId thì ta tìm 1 shop đại diện hoặc null (tuỳ schema bắt buộc hay ko)
            if (!orderData.shopId) {
                const Shop = db.shop;
                const defaultShop = await Shop.findOne({ status: "active" }).select("_id").lean();
                if (defaultShop) {
                    orderData.shopId = defaultShop._id;
                }
            }

            // Lưu order mới vào DB
            order = new EtsyOrder(orderData);
            await order.save();
        }

        if (!Array.isArray(order.items) || order.items.length === 0) {
            return res.status(400).json({ message: "Order has no items" });
        }

        // Etsy mặc định Standard shipping nếu ko có
        const shippingTypeForOrder = order.shipping_type || "Standard";

        const calculationData = await calculateEtsyCost(order);

        return res.json({
            platform: "etsy",
            orderId,
            base_cost: order.base_cost,
            preferred_vendor_id: calculationData.preferredVendorId || null,
            shipping_group_breakdowns: calculationData.groupBreakdowns,
            detail: calculationData.perItemResults,
        });

    } catch (err) {
        return res.status(500).json({ message: "Compute failed for Etsy Order", error: err.message });
    }
}
/* ================== STATISTICS (GIỐNG AMAZON) ================== */

const getEtsyOrderStatistics = async (req, res) => {
    try {
        const {
            shopId,
            sellerCode,
            sellerId,
            from,
            to,
            search,
            shipping_type,
        } = req.query;

        // ===== BUILD MATCH =====
        const match = {};

        if (shopId && mongoose.Types.ObjectId.isValid(shopId)) {
            match.shopId = new mongoose.Types.ObjectId(shopId);
        }
        if (sellerCode) match["seller.sellerCode"] = new RegExp(sellerCode, "i");
        if (sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
            match["seller.sellerId"] = new mongoose.Types.ObjectId(sellerId);
        }
        if (shipping_type) match.shipping_type = shipping_type;

        // Date range
        if (from || to) {
            match.saleDate = {};
            if (from) match.saleDate.$gte = new Date(from);
            if (to) match.saleDate.$lte = new Date(to);
        }

        // Search
        if (search) {
            const regex = new RegExp(search, "i");
            match.$or = [
                { orderId: regex },
                { "buyer.fullName": regex },
                { "buyer.userId": regex },
                { "items.sku": regex },
                { "items.itemName": regex },
                { "seller.sellerCode": regex },
            ];
        }

        // ===== FACET CONDITIONS =====
        const NO_COST_CENTER = {
            $and: [
                {
                    $or: [
                        { base_cost: { $exists: false } },
                        { base_cost: null },
                        { base_cost: 0 },
                    ],
                },
                { status: { $ne: "Cancelled" } },
            ],
        };

        const [stat] = await EtsyOrder.aggregate([
            { $match: match },
            {
                $facet: {
                    all: [{ $count: "c" }],
                    new: [
                        { $match: { $or: [{ status: "New" }, { status: "" }, { status: null }] } },
                        { $count: "c" },
                    ],
                    noCostCenter: [{ $match: NO_COST_CENTER }, { $count: "c" }],
                    fulfilled: [{ $match: { status: "Fulfilled" } }, { $count: "c" }],
                    shipped: [{ $match: { status: "Shipped" } }, { $count: "c" }],
                    cancelled: [{ $match: { status: "Cancelled" } }, { $count: "c" }],
                    refund: [{ $match: { status: "Refund" } }, { $count: "c" }],
                    invalidAddress: [
                        { $match: { "address_validation.isValid": false } },
                        { $count: "c" },
                    ],
                },
            },
            {
                $project: {
                    all: { $ifNull: [{ $arrayElemAt: ["$all.c", 0] }, 0] },
                    new: { $ifNull: [{ $arrayElemAt: ["$new.c", 0] }, 0] },
                    noCostCenter: { $ifNull: [{ $arrayElemAt: ["$noCostCenter.c", 0] }, 0] },
                    fulfilled: { $ifNull: [{ $arrayElemAt: ["$fulfilled.c", 0] }, 0] },
                    shipped: { $ifNull: [{ $arrayElemAt: ["$shipped.c", 0] }, 0] },
                    cancelled: { $ifNull: [{ $arrayElemAt: ["$cancelled.c", 0] }, 0] },
                    refund: { $ifNull: [{ $arrayElemAt: ["$refund.c", 0] }, 0] },
                    invalidAddress: { $ifNull: [{ $arrayElemAt: ["$invalidAddress.c", 0] }, 0] },
                },
            },
        ]);

        return res.json(
            stat || {
                all: 0,
                new: 0,
                noCostCenter: 0,
                fulfilled: 0,
                shipped: 0,
                cancelled: 0,
                refund: 0,
                invalidAddress: 0,
            }
        );
    } catch (err) {
        console.error("❌ getEtsyOrderStatistics error:", err);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};

/* ================== CREATE ORDER (TỪ MODAL TEXT INPUT) ================== */

const SHIPPING_TYPE_ENUM = ["SecondDay", "Ground", "Overnight", "Economy", "Standard", "Expedited"];

const firstNonBlankString = (...values) => {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const s = String(value).trim();
        if (s) return s;
    }
    return undefined;
};

const isMissingValue = (value) => {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.trim() === "";
    return false;
};

const isEmptyObject = (value) => (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
);

const deriveSellerCodeFromItems = (items = []) => {
    for (const item of items) {
        const sellerCode = getSellerCodeFromSku(item?.sku);
        if (sellerCode) return sellerCode;
    }
    return undefined;
};

const normalizeItem = (raw, idx) => {
    const transactionId = String(raw?.transactionId ?? "").trim();
    if (!transactionId) {
        const err = new Error(`items[${idx}].transactionId is required`);
        err.status = 400;
        throw err;
    }

    let variations = raw?.variations;
    if (typeof variations === "string") variations = parseVariations(variations);
    if (!variations || typeof variations !== "object") variations = {};

    return {
        transactionId,
        listingId: firstNonBlankString(raw?.listingId, raw?.listing_id, raw?.listingID, raw?.listing),
        sku: firstNonBlankString(
            raw?.sku,
            raw?.SKU,
            raw?.productSku,
            raw?.product_sku,
            raw?.productIdentifier,
            raw?.product_identifier
        ),
        itemName: raw?.itemName ? String(raw.itemName).trim() : undefined,
        quantity: toInt(raw?.quantity),
        unitPrice: toNumber(raw?.unitPrice),
        itemTotal: toNumber(raw?.itemTotal),
        variationsRaw: raw?.variationsRaw ? String(raw.variationsRaw) : undefined,
        variations,
        cost_breakdown: raw?.cost_breakdown ?? null,
        baseImage: raw?.baseImage && typeof raw.baseImage === "object" ? {
            imageUrl: raw.baseImage.imageUrl ? String(raw.baseImage.imageUrl) : undefined,
            width: toInt(raw.baseImage.width),
            height: toInt(raw.baseImage.height),
        } : undefined,
    };
};

const buildEtsyOrderPayload = (body) => {
    const orderId = String(body?.orderId ?? "").trim();
    if (!orderId) {
        const err = new Error("orderId is required");
        err.status = 400;
        throw err;
    }

    const shopIdRaw = String(body?.shopId ?? "").trim();
    if (!mongoose.Types.ObjectId.isValid(shopIdRaw)) {
        const err = new Error("shopId is required and must be a valid ObjectId");
        err.status = 400;
        throw err;
    }

    const items = Array.isArray(body?.items) ? body.items.map(normalizeItem) : [];

    const txSet = new Set();
    for (const it of items) {
        if (txSet.has(it.transactionId)) {
            const err = new Error(`Duplicate transactionId in items: ${it.transactionId}`);
            err.status = 400;
            throw err;
        }
        txSet.add(it.transactionId);
    }

    const sellerIdRaw = body?.seller?.sellerId;
    const sellerId = sellerIdRaw && mongoose.Types.ObjectId.isValid(sellerIdRaw)
        ? new mongoose.Types.ObjectId(sellerIdRaw)
        : undefined;
    const sellerCode = firstNonBlankString(body?.seller?.sellerCode) || deriveSellerCodeFromItems(items);

    const shippingType = body?.shipping_type && SHIPPING_TYPE_ENUM.includes(body.shipping_type)
        ? body.shipping_type
        : "Standard";

    return {
        orderId,
        shopId: new mongoose.Types.ObjectId(shopIdRaw),

        saleDate: toDate(body?.saleDate),
        paidAt: toDate(body?.paidAt),
        shippedAt: toDate(body?.shippedAt),

        status: body?.status ? String(body.status).trim() : "New",

        orderType: body?.orderType ? String(body.orderType) : undefined,
        listingsType: body?.listingsType ? String(body.listingsType) : undefined,
        paymentType: body?.paymentType ? String(body.paymentType) : undefined,
        paymentMethod: body?.paymentMethod ? String(body.paymentMethod) : undefined,
        currency: body?.currency ? String(body.currency).trim().slice(0, 3).toUpperCase() : undefined,

        buyer: {
            userId: body?.buyer?.userId ? String(body.buyer.userId) : undefined,
            fullName: body?.buyer?.fullName ? String(body.buyer.fullName) : undefined,
            firstName: body?.buyer?.firstName ? String(body.buyer.firstName) : undefined,
            lastName: body?.buyer?.lastName ? String(body.buyer.lastName) : undefined,
            display: body?.buyer?.display ? String(body.buyer.display) : undefined,
        },

        seller: {
            sellerId,
            sellerCode,
        },

        coupon: {
            code: body?.coupon?.code ? String(body.coupon.code) : undefined,
            details: body?.coupon?.details ? String(body.coupon.details) : undefined,
        },

        shipping: {
            name: body?.shipping?.name ? String(body.shipping.name) : undefined,
            address1: body?.shipping?.address1 ? String(body.shipping.address1) : undefined,
            address2: body?.shipping?.address2 ? String(body.shipping.address2) : undefined,
            city: body?.shipping?.city ? String(body.shipping.city) : undefined,
            state: body?.shipping?.state ? String(body.shipping.state) : undefined,
            zipcode: body?.shipping?.zipcode ? String(body.shipping.zipcode) : undefined,
            country: body?.shipping?.country ? String(body.shipping.country) : undefined,
        },

        shipping_type: shippingType,

        totals: {
            orderValue: toNumber(body?.totals?.orderValue),
            shipping: toNumber(body?.totals?.shipping),
            salesTax: toNumber(body?.totals?.salesTax),
            orderTotal: toNumber(body?.totals?.orderTotal),
            cardProcessingFees: toNumber(body?.totals?.cardProcessingFees),
            orderNet: toNumber(body?.totals?.orderNet),
            fee: toNumber(body?.totals?.fee),
            adjustedOrderTotal: toNumber(body?.totals?.adjustedOrderTotal),
            adjustedCardProcessingFees: toNumber(body?.totals?.adjustedCardProcessingFees),
            adjustedNet: toNumber(body?.totals?.adjustedNet),
            adjustedOrderValue: toNumber(body?.totals?.adjustedOrderValue),
            adjustedShipping: toNumber(body?.totals?.adjustedShipping),
            adjustedSalesTax: toNumber(body?.totals?.adjustedSalesTax),
            orderShipping: toNumber(body?.totals?.orderShipping),
            orderSalesTax: toNumber(body?.totals?.orderSalesTax),
            discountAmount: toNumber(body?.totals?.discountAmount),
            shippingDiscount: toNumber(body?.totals?.shippingDiscount),
            inPersonDiscount: toNumber(body?.totals?.inPersonDiscount),
            vatPaidByBuyer: toNumber(body?.totals?.vatPaidByBuyer),
        },

        numberOfItems: toInt(body?.numberOfItems) ?? items.reduce((s, i) => s + (i.quantity || 0), 0),

        items,
    };
};

const backfillExistingEtsyOrder = async (existing, payload) => {
    const incomingItems = Array.isArray(payload.items) ? payload.items : [];
    const existingItems = Array.isArray(existing.items) ? existing.items : [];
    const existingItemsCount = existingItems.length;
    const itemByTx = new Map();

    for (const item of existingItems) {
        if (item?.transactionId) itemByTx.set(String(item.transactionId), item);
    }

    let matchedItems = 0;
    let updatedItems = 0;
    let addedItems = 0;
    let skuBackfilled = 0;
    let listingIdBackfilled = 0;
    const samples = [];

    const backfillField = (target, source, field) => {
        if (!source || isMissingValue(source[field]) || !isMissingValue(target[field])) return false;
        target[field] = source[field];
        return true;
    };

    for (const incoming of incomingItems) {
        const tx = String(incoming.transactionId || "");
        const current = itemByTx.get(tx);

        if (!current) {
            existing.items.push(incoming);
            addedItems += 1;
            samples.push({
                transactionId: tx,
                action: "added",
                oldSku: "",
                newSku: incoming.sku || "",
                oldListingId: "",
                newListingId: incoming.listingId || "",
            });
            continue;
        }

        matchedItems += 1;
        const oldSku = current.sku || "";
        const oldListingId = current.listingId || "";
        let itemChanged = false;

        if (backfillField(current, incoming, "sku")) {
            skuBackfilled += 1;
            itemChanged = true;
        }
        if (backfillField(current, incoming, "listingId")) {
            listingIdBackfilled += 1;
            itemChanged = true;
        }
        if (backfillField(current, incoming, "itemName")) itemChanged = true;
        if (backfillField(current, incoming, "variationsRaw")) itemChanged = true;

        if ((isMissingValue(current.baseImage?.imageUrl)) && incoming.baseImage?.imageUrl) {
            if (!current.baseImage) current.baseImage = {};
            current.baseImage.imageUrl = incoming.baseImage.imageUrl;
            if (isMissingValue(current.baseImage.width) && incoming.baseImage.width != null) current.baseImage.width = incoming.baseImage.width;
            if (isMissingValue(current.baseImage.height) && incoming.baseImage.height != null) current.baseImage.height = incoming.baseImage.height;
            itemChanged = true;
        }

        if ((!current.variations || isEmptyObject(current.variations)) && incoming.variations && !isEmptyObject(incoming.variations)) {
            current.variations = incoming.variations;
            itemChanged = true;
        }

        if ((current.cost_breakdown === null || current.cost_breakdown === undefined) && incoming.cost_breakdown !== null && incoming.cost_breakdown !== undefined) {
            current.cost_breakdown = incoming.cost_breakdown;
            itemChanged = true;
        }

        if (itemChanged) {
            updatedItems += 1;
            samples.push({
                transactionId: tx,
                action: "backfilled",
                oldSku,
                newSku: current.sku || "",
                oldListingId,
                newListingId: current.listingId || "",
            });
        }
    }

    let sellerBackfilled = false;
    if (isMissingValue(existing.seller?.sellerCode) && payload.seller?.sellerCode) {
        if (!existing.seller) existing.seller = {};
        existing.seller.sellerCode = payload.seller.sellerCode;
        sellerBackfilled = true;
    }

    const backfilled = updatedItems > 0 || addedItems > 0 || sellerBackfilled;
    if (backfilled) {
        existing.numberOfItems = existing.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
        if (updatedItems > 0 || addedItems > 0) existing.markModified("items");
        if (sellerBackfilled) existing.markModified("seller");
        await existing.save();
    }

    console.log("[ETSY_ORDER_BACKFILL]", {
        shopId: String(payload.shopId),
        orderId: payload.orderId,
        existingItems: existingItemsCount,
        incomingItems: incomingItems.length,
        matchedItems,
        addedItems,
        skuBackfilled,
        listingIdBackfilled,
        sample: samples.slice(0, 20),
    });

    return {
        backfilled,
        updatedItems,
        addedItems,
        skuBackfilled,
        listingIdBackfilled,
    };
};

const createOrder = async (req, res) => {
    try {
        const payload = buildEtsyOrderPayload(req.body || {});

        const existing = await EtsyOrder.findOne({ orderId: payload.orderId, shopId: payload.shopId });
        if (existing) {
            const result = await backfillExistingEtsyOrder(existing, payload);
            if (payload.seller?.sellerCode) {
                await fillSellerIfMissing(payload.orderId, payload.shopId, payload.seller.sellerCode);
            }
            return res.status(200).json({
                ok: true,
                duplicated: true,
                backfilled: result.backfilled,
                orderId: payload.orderId,
                updatedItems: result.updatedItems,
                addedItems: result.addedItems,
                skuBackfilled: result.skuBackfilled,
                listingIdBackfilled: result.listingIdBackfilled,
            });
        }

        const doc = await EtsyOrder.create(payload);
        if (payload.seller?.sellerCode) {
            await fillSellerIfMissing(payload.orderId, payload.shopId, payload.seller.sellerCode);
        }
        return res.status(201).json(doc);
    } catch (err) {
        if (err?.status === 400) return res.status(400).json({ message: err.message });
        if (err?.code === 11000) return res.status(409).json({ message: "Duplicate orderId", keyValue: err.keyValue });
        if (err?.name === "ValidationError") return res.status(400).json({ message: err.message, errors: err.errors });
        console.error("❌ createOrder error:", err);
        return res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

const updateSumbittedoetsyStatus = async (req, res) => {
    try {
        const body = req.body || {};
        const orderId = String(body.orderId || body.oderid || "").trim();
        const shopId = String(body.shopId || "").trim();
        const nextStatus = toBooleanStrict(
            body.sumbittedoetsy ?? body.submittedToEtsy ?? body.submitted_to_etsy
        );

        if (!orderId) {
            return res.status(400).json({ ok: false, message: "orderId is required" });
        }
        if (!shopId) {
            return res.status(400).json({ ok: false, message: "shopId is required" });
        }
        if (!mongoose.Types.ObjectId.isValid(shopId)) {
            return res.status(400).json({ ok: false, message: "shopId must be a valid ObjectId" });
        }
        if (nextStatus === null) {
            return res.status(400).json({
                ok: false,
                message: "sumbittedoetsy must be true or false",
            });
        }

        const updated = await EtsyOrder.findOneAndUpdate(
            { orderId, shopId },
            { $set: { sumbittedoetsy: nextStatus } },
            { new: true }
        )
            .select({ orderId: 1, shopId: 1, sumbittedoetsy: 1, updatedAt: 1 })
            .lean();

        if (!updated) {
            return res.status(404).json({
                ok: false,
                message: "Etsy order not found",
                orderId,
                shopId,
            });
        }

        return res.json({
            ok: true,
            orderId: updated.orderId,
            shopId: String(updated.shopId),
            sumbittedoetsy: updated.sumbittedoetsy ?? false,
            updatedAt: updated.updatedAt,
        });
    } catch (err) {
        console.error("updateSumbittedoetsyStatus error:", err);
        return res.status(500).json({ ok: false, message: "Internal Server Error", error: err.message });
    }
};

const updateEtsyOrderItemTracking = async (req, res) => {
    try {
        const orderId = String(req.params.orderId || "").trim();
        const transactionId = String(req.params.transactionId || req.params.orderItemId || "").trim();
        const body = req.body || {};

        const fulfillment = body.fulfillment !== undefined ? String(body.fulfillment).trim() : undefined;
        const tracking = body.tracking !== undefined ? String(body.tracking).trim() : undefined;
        const note = body.note !== undefined ? String(body.note) : undefined;
        const status = body.status !== undefined ? String(body.status).trim() : undefined;

        if (!orderId) return res.status(400).json({ ok: false, message: "orderId is required" });
        if (!transactionId) return res.status(400).json({ ok: false, message: "transactionId is required" });
        if (
            fulfillment === undefined &&
            tracking === undefined &&
            status === undefined &&
            note === undefined
        ) {
            return res.status(400).json({
                ok: false,
                message: "No updatable fields provided (fulfillment/tracking/status/note)",
            });
        }
        if (status && !ETSY_TRACKING_STATUSES.includes(status)) {
            return res.status(400).json({
                ok: false,
                message: "Invalid status",
                allowed: ETSY_TRACKING_STATUSES,
            });
        }

        let nextStatus;
        if (isEtsyCanceledStatus(status)) {
            nextStatus = "Canceled";
        } else if (tracking !== undefined && tracking.length > 0) {
            nextStatus = "Shipped";
        } else {
            nextStatus = status;
        }

        const set = {
            "items.$.tracking_info.updated_at": new Date(),
        };
        if (fulfillment !== undefined) set["items.$.tracking_info.fulfillment"] = fulfillment;
        if (tracking !== undefined) set["items.$.tracking_info.tracking"] = tracking;
        if (note !== undefined) set["items.$.tracking_info.note"] = note;
        if (nextStatus !== undefined) set["items.$.tracking_info.status"] = nextStatus;

        const updated = await EtsyOrder.findOneAndUpdate(
            { orderId, "items.transactionId": transactionId },
            { $set: set },
            { new: true }
        ).lean();

        if (!updated) {
            return res.status(404).json({
                ok: false,
                message: "Etsy order or item not found",
                orderId,
                transactionId,
            });
        }

        const orderStatus = computeEtsyOrderStatusFromItems(updated.items || []);
        if (orderStatus !== updated.status) {
            await EtsyOrder.updateOne({ _id: updated._id }, { $set: { status: orderStatus } });
            updated.status = orderStatus;
        }

        const item = (updated.items || []).find((entry) => String(entry.transactionId) === transactionId);

        return res.json({
            ok: true,
            orderId: updated.orderId,
            shopId: String(updated.shopId || ""),
            transactionId,
            orderStatus: updated.status,
            tracking_info: item?.tracking_info || {},
            applied: {
                fulfillment,
                tracking,
                status: nextStatus,
                note,
            },
        });
    } catch (err) {
        console.error("updateEtsyOrderItemTracking error:", err);
        return res.status(500).json({ ok: false, message: "Internal Server Error", error: err.message });
    }
};

const ETSY_SCALE_KNOWN = [
    "Need Scale",
    "Pending",
    "Ready",
    "Sent",
    "Failed",
    "QC Rejected",
    "Cancelled",
    "Address Invalid",
];

const ETSY_SCALE_ACTIVE = ["Need Scale", "Pending", "Sent", "QC Rejected"];
const ETSY_QC_ACTIVE = ["Pending", "Sent", "QC Rejected", "Ready", "Address Invalid"];

const hasRole = (userRole, target) => {
    if (!userRole) return false;
    const normalize = (value) => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
    const wanted = normalize(target);
    if (Array.isArray(userRole)) return userRole.some((role) => normalize(role) === wanted);
    if (typeof userRole === "object" && Array.isArray(userRole.roles)) {
        return userRole.roles.some((role) => normalize(role) === wanted);
    }
    return normalize(userRole) === wanted;
};

const canonScaleStatus = (value) => {
    const status = String(value || "").trim();
    if (!status) return "";
    if (/^complete$/i.test(status)) return "Ready";
    if (/^qc\s*reject(?:ed)?$/i.test(status)) return "QC Rejected";
    if (/^addr(?:ess)?\s*invalid$/i.test(status)) return "Address Invalid";
    return status;
};

function computeEtsyOverallScaleStatus(items = []) {
    if (!Array.isArray(items) || items.length === 0) return "Need Scale";
    const statuses = items.map((item) => String(item?.scale_status || "Need Scale"));
    if (statuses.some((status) => status === "QC Rejected")) return "QC Rejected";
    if (statuses.every((status) => status === "Complete")) return "Ready";
    if (statuses.every((status) => status === "Pending" || status === "Complete")) return "Pending";
    return "Need Scale";
}

const toPlainFulfillmentFile = (value) => {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value);
    if (typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value === "string") return { file: value };
    return {};
};

const hasAnyFulfillmentFile = (value) => Object.values(toPlainFulfillmentFile(value)).some(Boolean);

const getRequester = (req) => ({
    userId: req.user?.userId || req.user?.id || req.user?._id || "",
    role: req.user?.role,
});

const isSellerOnlyUser = (role) =>
    hasRole(role, "Seller") &&
    !(hasRole(role, "Admin") || hasRole(role, "Customer Service") || hasRole(role, "Design Leader"));

const buildEtsyOrderLookup = (req) => {
    const orderId = String(req.params.orderId || req.body?.orderId || "").trim();
    const shopId = String(req.query.shopId || req.body?.shopId || "").trim();
    const query = { orderId };
    if (shopId && mongoose.Types.ObjectId.isValid(shopId)) query.shopId = new mongoose.Types.ObjectId(shopId);
    return query;
};

const ensureSellerCanAccessEtsyOrder = (req, order) => {
    const { userId, role } = getRequester(req);
    if (!isSellerOnlyUser(role)) return null;
    if (!mongoose.Types.ObjectId.isValid(userId)) return "Invalid user id in token";
    if (String(order?.seller?.sellerId || "") !== String(userId)) {
        return "You can only access your own Etsy orders";
    }
    return null;
};

const buildEtsyScalePipeline = (req, activeStatuses) => {
    const {
        from,
        to,
        scale_status,
        search,
        shopName,
        cs_unassigned = "",
        cs_assignee_id = "",
        cs_assignment_status = "",
        sellerId,
    } = req.query;

    const { userId, role } = getRequester(req);
    const isSellerOnly = isSellerOnlyUser(role);
    const isCS = hasRole(role, "Customer Service");

    const matchStage = {};
    if (from && to) matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    if (isSellerOnly && mongoose.Types.ObjectId.isValid(userId)) {
        matchStage["seller.sellerId"] = new mongoose.Types.ObjectId(userId);
    }
    if (isCS && mongoose.Types.ObjectId.isValid(userId)) {
        matchStage.csAssigneeId = new mongoose.Types.ObjectId(userId);
    }

    const pipeline = [
        { $match: matchStage },
        {
            $lookup: {
                from: "shops",
                localField: "shopId",
                foreignField: "_id",
                as: "shop",
            },
        },
        { $unwind: { path: "$shop", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                localField: "seller.sellerId",
                foreignField: "_id",
                as: "sellerUser",
            },
        },
        { $unwind: { path: "$sellerUser", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                localField: "scaleId",
                foreignField: "_id",
                as: "scaledBy",
            },
        },
        { $unwind: { path: "$scaledBy", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                localField: "csAssigneeId",
                foreignField: "_id",
                as: "cs_assignee",
            },
        },
        { $unwind: { path: "$cs_assignee", preserveNullAndEmptyArrays: true } },
        ...(shopName && shopName.trim()
            ? [{ $match: { "shop.name": { $regex: new RegExp(shopName.trim(), "i") } } }]
            : []),
    ];

    if (!isSellerOnly && sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
        pipeline.push({ $match: { "sellerUser._id": new mongoose.Types.ObjectId(sellerId) } });
    }

    if (search && search.trim()) {
        const keyword = new RegExp(search.trim(), "i");
        pipeline.push({
            $match: {
                $or: [
                    { orderId: keyword },
                    { "items.sku": keyword },
                    { "items.transactionId": keyword },
                    { "items.itemName": keyword },
                    { "buyer.fullName": keyword },
                    { "buyer.display": keyword },
                    { "shipping.name": keyword },
                    { "sellerUser.full_name": keyword },
                    { "sellerUser.email": keyword },
                ],
            },
        });
    }

    if (String(cs_unassigned || "").toLowerCase() === "true") {
        pipeline.push({
            $match: {
                $or: [
                    { csAssigneeId: { $exists: false } },
                    { csAssigneeId: null },
                    { cs_assignment_status: "Unassigned" },
                ],
            },
        });
    }
    if (cs_assignee_id && mongoose.Types.ObjectId.isValid(cs_assignee_id)) {
        pipeline.push({ $match: { csAssigneeId: new mongoose.Types.ObjectId(cs_assignee_id) } });
    }
    if (cs_assignment_status && String(cs_assignment_status).trim()) {
        pipeline.push({ $match: { cs_assignment_status: String(cs_assignment_status).trim() } });
    }

    pipeline.push({
        $addFields: {
            hasPendingItem: {
                $anyElementTrue: {
                    $map: {
                        input: { $ifNull: ["$items", []] },
                        as: "it",
                        in: { $eq: [{ $ifNull: ["$$it.scale_status", "Need Scale"] }, "Pending"] },
                    },
                },
            },
            overall_status_bucket: {
                $let: {
                    vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
                    in: { $cond: [{ $in: ["$$s", ETSY_SCALE_KNOWN] }, "$$s", "Other"] },
                },
            },
        },
    });

    let onlyPending = false;
    if (scale_status && String(scale_status).trim()) {
        if (/^all$/i.test(String(scale_status).trim())) {
            pipeline.push({ $match: { overall_status_bucket: { $in: activeStatuses } } });
        } else {
            const wanted = String(scale_status).split(",").map(canonScaleStatus).filter(Boolean);
            const valid = wanted.filter((status) => ETSY_SCALE_KNOWN.includes(status));
            pipeline.push({ $match: { overall_status_bucket: { $in: valid.length ? valid : ["__NO_MATCH__"] } } });
            onlyPending = valid.length === 1 && valid[0] === "Pending";
        }
    } else {
        pipeline.push({ $match: { overall_status_bucket: { $in: activeStatuses } } });
    }

    if (onlyPending) {
        pipeline.push({
            $addFields: {
                items: {
                    $filter: {
                        input: { $ifNull: ["$items", []] },
                        as: "it",
                        cond: { $eq: [{ $ifNull: ["$$it.scale_status", "Need Scale"] }, "Pending"] },
                    },
                },
            },
        });
        pipeline.push({ $match: { $expr: { $gt: [{ $size: { $ifNull: ["$items", []] } }, 0] } } });
    }

    return pipeline;
};

const mapEtsyScaleOrder = (order) => ({
    orderId: order.orderId,
    shopId: order.shopId ? String(order.shopId) : null,
    shopName: order.shop?.name || null,
    status: order.status || "",
    saleDate: order.saleDate,
    createdAt: order.createdAt,
    shipping_type: order.shipping_type || "Standard",
    customer_infor: {
        email: "",
        name: order.shipping?.name || order.buyer?.fullName || order.buyer?.display || "",
        address: order.shipping?.address1 || "",
        address_2: order.shipping?.address2 || "",
        city: order.shipping?.city || "",
        state: order.shipping?.state || "",
        zip_code: order.shipping?.zipcode || "",
        country: order.shipping?.country || "",
        phone_number: "",
    },
    buyer: order.buyer || {},
    shipping: order.shipping || {},
    items: (order.items || []).map((item) => {
        const vendorProductId = item?.cost_breakdown?.vendorProductId || null;
        return {
            orderItemId: item.transactionId || null,
            transactionId: item.transactionId || null,
            listingId: item.listingId || null,
            sku: item.sku || "",
            title: item.itemName || "",
            itemName: item.itemName || "",
            quantity: item.quantity || 1,
            variations: item.variations || {},
            variationsRaw: item.variationsRaw || "",
            baseImageUrl: item.baseImage?.imageUrl || null,
            cost_center: {
                vendorProductId,
                sizeValue: item?.cost_breakdown?.sizeValue || null,
                colorValue: item?.cost_breakdown?.colorValue || null,
                vendorProductSKU: item?.cost_breakdown?.matchedSku || null,
            },
            tracking_info: item.tracking_info || {},
            fulfillment_file: toPlainFulfillmentFile(item.fulfillment_file),
            scale_status: item.scale_status || "Need Scale",
            qc_note: item.qc_note || "",
            cs_note: item.cs_note || "",
        };
    }),
    base_cost: order.base_cost || 0,
    address_validation: order.address_validation?.isValid,
    scale_overall_status: order.scale_overall_status || "Need Scale",
    scaledBy: order.scaledBy
        ? { _id: order.scaledBy._id, full_name: order.scaledBy.full_name, email: order.scaledBy.email }
        : null,
    cs_assignment_status: order.cs_assignment_status || "Unassigned",
    csAssignedAt: order.csAssignedAt || null,
    cs_assignee: order.cs_assignee
        ? { _id: order.cs_assignee._id, full_name: order.cs_assignee.full_name, email: order.cs_assignee.email }
        : null,
    seller: order.sellerUser
        ? { _id: order.sellerUser._id, full_name: order.sellerUser.full_name, email: order.sellerUser.email }
        : null,
});

const getEtsyScaleList = async (req, res) => {
    try {
        const { page = 1, perPage = 10 } = req.query;
        const pipeline = buildEtsyScalePipeline(req, ETSY_SCALE_ACTIVE);
        const countResult = await EtsyOrder.aggregate([...pipeline, { $count: "total" }]);
        const totalCount = countResult?.[0]?.total || 0;
        const isAll = String(perPage).toLowerCase() === "all";
        const pageNum = parseInt(page, 10) || 1;
        const limitNum = isAll ? totalCount || 1 : parseInt(perPage, 10) || 10;
        const skip = isAll ? 0 : (pageNum - 1) * limitNum;

        pipeline.push({ $sort: { saleDate: 1, createdAt: 1 } });
        if (!isAll) pipeline.push({ $skip: skip }, { $limit: limitNum });

        const orders = await EtsyOrder.aggregate(pipeline);
        return res.json({
            data: orders.map(mapEtsyScaleOrder),
            totalCount,
            totalPages: isAll ? 1 : Math.ceil(totalCount / limitNum),
            currentPage: pageNum,
        });
    } catch (err) {
        console.error("getEtsyScaleList error:", err);
        return res.status(500).json({ message: "Failed to retrieve Etsy scale list", error: err.message });
    }
};

const getEtsyQCList = async (req, res) => {
    try {
        const { page = 1, perPage = 10 } = req.query;
        const pipeline = buildEtsyScalePipeline(req, ETSY_QC_ACTIVE);
        const countResult = await EtsyOrder.aggregate([...pipeline, { $count: "total" }]);
        const totalCount = countResult?.[0]?.total || 0;
        const isAll = String(perPage).toLowerCase() === "all";
        const pageNum = parseInt(page, 10) || 1;
        const limitNum = isAll ? totalCount || 1 : parseInt(perPage, 10) || 10;
        const skip = isAll ? 0 : (pageNum - 1) * limitNum;

        pipeline.push({ $sort: { createdAt: -1 } });
        if (!isAll) pipeline.push({ $skip: skip }, { $limit: limitNum });

        const orders = await EtsyOrder.aggregate(pipeline);
        return res.json({
            data: orders.map(mapEtsyScaleOrder),
            totalCount,
            totalPages: isAll ? 1 : Math.ceil(totalCount / limitNum),
            currentPage: pageNum,
        });
    } catch (err) {
        console.error("getEtsyQCList error:", err);
        return res.status(500).json({ message: "Failed to retrieve Etsy QC list", error: err.message });
    }
};

const getEtsyScaleStatistics = async (req, res) => {
    try {
        const pipeline = buildEtsyScalePipeline(req, ETSY_SCALE_ACTIVE);
        const [raw] = await EtsyOrder.aggregate([
            ...pipeline,
            { $group: { _id: "$overall_status_bucket", orders: { $sum: 1 }, pending: { $sum: { $cond: ["$hasPendingItem", 1, 0] } } } },
            { $group: { _id: null, totalOrders: { $sum: "$orders" }, byStatus: { $push: { k: "$_id", v: "$orders" } }, pendingAdj: { $sum: "$pending" } } },
            { $project: { _id: 0, totalOrders: 1, counts: { $arrayToObject: "$byStatus" }, pendingAdj: 1 } },
        ]);
        const c = raw?.counts || {};
        const counts = {
            "Need Scale": c["Need Scale"] || 0,
            Pending: raw?.pendingAdj || c.Pending || 0,
            Ready: c.Ready || 0,
            Sent: c.Sent || 0,
            Failed: c.Failed || 0,
            "QC Rejected": c["QC Rejected"] || 0,
            Other: c.Other || 0,
        };
        counts.All = counts["Need Scale"] + counts.Pending + counts.Sent + counts["QC Rejected"];
        return res.json({ overall: { totalOrders: raw?.totalOrders || 0, counts }, breakdown: [], timeseries: [] });
    } catch (err) {
        return res.status(500).json({ message: "Failed to retrieve Etsy scale statistics", error: err.message });
    }
};

const getEtsyQCStatistics = async (req, res) => {
    try {
        const pipeline = buildEtsyScalePipeline(req, ETSY_QC_ACTIVE);
        const [raw] = await EtsyOrder.aggregate([
            ...pipeline,
            { $group: { _id: "$overall_status_bucket", orders: { $sum: 1 } } },
            { $group: { _id: null, totalOrders: { $sum: "$orders" }, byStatus: { $push: { k: "$_id", v: "$orders" } } } },
            { $project: { _id: 0, totalOrders: 1, counts: { $arrayToObject: "$byStatus" } } },
        ]);
        const c = raw?.counts || {};
        const counts = {
            "Need Scale": c["Need Scale"] || 0,
            Pending: c.Pending || 0,
            Ready: c.Ready || 0,
            Sent: c.Sent || 0,
            Failed: c.Failed || 0,
            "QC Rejected": c["QC Rejected"] || 0,
            "Address Invalid": c["Address Invalid"] || 0,
            Other: c.Other || 0,
        };
        counts.All = counts.Pending + counts.Sent + counts["QC Rejected"] + counts.Ready + counts["Address Invalid"];
        return res.json({ overall: { totalOrders: counts.All, counts } });
    } catch (err) {
        return res.status(500).json({ message: "Failed to retrieve Etsy QC statistics", error: err.message });
    }
};

const uploadEtsyFulfillmentFileForItem = [
    etsyScaleUpload.array("files"),
    async (req, res) => {
        try {
            const { transactionId } = req.params;
            const userId = req.user?.userId || req.user?.id || req.user?._id || null;
            if (!req.files?.length) return res.status(400).json({ message: "Missing files" });

            let positions = [];
            try {
                positions = JSON.parse(req.body?.meta || "[]");
            } catch {
                return res.status(400).json({ message: "Invalid meta JSON" });
            }
            if (positions.length !== req.files.length) {
                return res.status(400).json({ message: "Files count not match positions" });
            }

            const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
            if (!order) return res.status(404).json({ message: "Etsy order not found" });
            const accessError = ensureSellerCanAccessEtsyOrder(req, order);
            if (accessError) return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });

            const item = (order.items || []).find((entry) => String(entry.transactionId) === String(transactionId));
            if (!item) return res.status(404).json({ message: "Etsy order item not found" });

            if (!item.fulfillment_file || !(item.fulfillment_file instanceof Map)) {
                item.fulfillment_file = new Map(Object.entries(toPlainFulfillmentFile(item.fulfillment_file)));
            }

            for (let i = 0; i < req.files.length; i += 1) {
                const file = req.files[i];
                const pos = String(positions[i]?.position || "").trim().toLowerCase();
                if (!pos) return res.status(400).json({ message: `Missing position for file index ${i}` });
                const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
                const safeOrderId = String(order.orderId).replace(/[^\w.-]+/g, "_");
                const safeTx = String(transactionId).replace(/[^\w.-]+/g, "_");
                const safePos = pos.replace(/[^\w.-]+/g, "_");
                const up = await uploadBufferToR2({
                    buffer: file.buffer,
                    originalName: file.originalname,
                    mimeType: file.mimetype,
                    size: file.size,
                    folder: "fulfillment_files",
                    key: `fulfillment_files/etsy-${safeOrderId}-${safeTx}-${safePos}${ext}`,
                });
                item.fulfillment_file.set(pos, up.url);
            }

            item.scale_status = "Pending";
            order.scale_overall_status = computeEtsyOverallScaleStatus(order.items);
            if (userId && mongoose.Types.ObjectId.isValid(userId)) order.scaleId = new mongoose.Types.ObjectId(userId);
            order.markModified("items");
            await order.save();

            return res.json({
                message: "Uploaded Etsy fulfillment files successfully",
                fulfillment_file: toPlainFulfillmentFile(item.fulfillment_file),
                item_scale_status: item.scale_status,
                order_scale_overall_status: order.scale_overall_status,
            });
        } catch (err) {
            console.error("uploadEtsyFulfillmentFileForItem error:", err);
            return res.status(500).json({ message: "Upload failed", error: err.message });
        }
    },
];

const confirmEtsyScaleForItem = async (req, res) => {
    try {
        const { transactionId } = req.params;
        const { decision, note } = req.body || {};
        const d = String(decision || "").toLowerCase();
        if (!["approve", "reject"].includes(d)) {
            return res.status(400).json({ message: 'Invalid decision. Must be "approve" or "reject".' });
        }

        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) return res.status(404).json({ message: "Etsy order not found" });
        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });

        const item = (order.items || []).find((entry) => String(entry.transactionId) === String(transactionId));
        if (!item) return res.status(404).json({ message: "Etsy order item not found" });

        if (d === "reject") {
            item.scale_status = "QC Rejected";
            item.fulfillment_file = new Map();
            if (note !== undefined) item.qc_note = String(note || "").trim();
            order.scale_overall_status = "QC Rejected";
        } else {
            if (!hasAnyFulfillmentFile(item.fulfillment_file)) {
                return res.status(400).json({
                    message: "Missing print files. Please upload fulfillment_file before approval.",
                });
            }
            item.scale_status = "Complete";
            if (note !== undefined) item.qc_note = String(note || "").trim();
            order.scale_overall_status = computeEtsyOverallScaleStatus(order.items);
            if (order.scale_overall_status === "Ready" && order.address_validation?.isValid === false) {
                order.scale_overall_status = "Address Invalid";
            }
        }

        order.markModified("items");
        await order.save();

        return res.json({
            message: d === "reject"
                ? "Etsy scale rejected. Item set to QC Rejected."
                : order.scale_overall_status === "Ready"
                    ? "Etsy item approved. Order is Ready."
                    : "Etsy item approved. Waiting for other items to be approved.",
            item_scale_status: item.scale_status,
            qc_note: item.qc_note || "",
            order_scale_overall_status: order.scale_overall_status,
        });
    } catch (err) {
        return res.status(500).json({ message: "Confirm failed", error: err.message });
    }
};

const updateEtsyItemNote = (field) => async (req, res) => {
    try {
        const { transactionId } = req.params;
        const noteValue = String(req.body?.[field] || "").trim();
        if (noteValue.length > 2000) {
            return res.status(400).json({ message: `${field} exceeds 2000 characters.` });
        }
        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) return res.status(404).json({ message: "Etsy order not found" });
        const accessError = ensureSellerCanAccessEtsyOrder(req, order);
        if (accessError) return res.status(accessError.startsWith("Invalid") ? 400 : 403).json({ message: accessError });

        const item = (order.items || []).find((entry) => String(entry.transactionId) === String(transactionId));
        if (!item) return res.status(404).json({ message: "Etsy order item not found" });
        item[field] = noteValue;
        order.markModified("items");
        await order.save();

        return res.json({
            message: `Etsy ${field} updated.`,
            orderId: order.orderId,
            transactionId,
            [field]: item[field],
        });
    } catch (err) {
        return res.status(500).json({ message: `Update ${field} failed`, error: err.message });
    }
};

const updateEtsyQCNoteForItem = updateEtsyItemNote("qc_note");
const updateEtsyCSNoteForItem = updateEtsyItemNote("cs_note");

const assignEtsyOrderToCS = async (req, res) => {
    try {
        const { orderId } = req.params;
        const { csUserId } = req.body || {};
        const assignedBy = req.user?.userId || req.user?.id || req.user?._id || null;

        if (!mongoose.Types.ObjectId.isValid(csUserId)) {
            return res.status(400).json({ message: "Invalid csUserId" });
        }

        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        const csUser = await User.findById(csUserId)
            .select("_id full_name email role_id")
            .lean();

        if (!csUser) {
            return res.status(404).json({ message: "CS user not found" });
        }

        if (!csUser.role_id || !mongoose.Types.ObjectId.isValid(csUser.role_id)) {
            return res.status(400).json({ message: "User does not have a valid role_id" });
        }

        const role = await Role.findById(csUser.role_id).select("name").lean();
        const roleName = String(role?.name || "").trim().toLowerCase();
        const allowedRoleNames = new Set([
            "customer service",
            "designer",
            "design leader",
        ]);

        if (!allowedRoleNames.has(roleName)) {
            return res.status(400).json({
                message: "Selected user must be Customer Service, Designer, or Design Leader",
                debug: {
                    userId: csUser._id,
                    role_id: csUser.role_id,
                    role_name: role?.name || null,
                },
            });
        }

        order.csAssigneeId = csUser._id;
        order.csAssignedBy = assignedBy && mongoose.Types.ObjectId.isValid(assignedBy)
            ? new mongoose.Types.ObjectId(assignedBy)
            : null;
        order.csAssignedAt = new Date();
        order.cs_assignment_status = "Assigned";

        await order.save();

        return res.json({
            message: "Assigned Etsy order to CS successfully",
            data: {
                orderId: order.orderId,
                shopId: String(order.shopId || ""),
                csAssigneeId: order.csAssigneeId,
                csAssignedBy: order.csAssignedBy,
                csAssignedAt: order.csAssignedAt,
                cs_assignment_status: order.cs_assignment_status,
                cs_assignee: {
                    _id: csUser._id,
                    full_name: csUser.full_name,
                    email: csUser.email,
                    role_name: role?.name || null,
                },
            },
        });
    } catch (err) {
        return res.status(500).json({
            message: "Assign Etsy order to CS failed",
            error: err.message,
        });
    }
};

const unassignEtsyOrderFromCS = async (req, res) => {
    try {
        const order = await EtsyOrder.findOne(buildEtsyOrderLookup(req));
        if (!order) {
            return res.status(404).json({ message: "Etsy order not found" });
        }

        order.csAssigneeId = null;
        order.csAssignedBy = null;
        order.csAssignedAt = null;
        order.cs_assignment_status = "Unassigned";

        await order.save();

        return res.json({
            message: "Unassigned Etsy CS successfully",
            data: {
                orderId: order.orderId,
                shopId: String(order.shopId || ""),
                cs_assignment_status: order.cs_assignment_status,
            },
        });
    } catch (err) {
        return res.status(500).json({
            message: "Unassign Etsy CS failed",
            error: err.message,
        });
    }
};

module.exports = {
    importOrders,
    getListOrders,
    computeBaseCostForEtsyOrder,
    getEtsyOrderStatistics,
    createOrder,
    updateSumbittedoetsyStatus,
    updateEtsyOrderItemTracking,
    getEtsyScaleList,
    getEtsyScaleStatistics,
    getEtsyQCList,
    getEtsyQCStatistics,
    uploadEtsyFulfillmentFileForItem,
    confirmEtsyScaleForItem,
    updateEtsyQCNoteForItem,
    updateEtsyCSNoteForItem,
    assignEtsyOrderToCS,
    unassignEtsyOrderFromCS,
};
