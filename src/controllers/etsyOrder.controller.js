const db = require('../models');
const mongoose = require('mongoose');
const EtsyOrder = db.EtsyOrder;
const EtsyListing = require('../models/etsyListing.model');
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

    let preferredVendorId = null;
    if (preItems.length >= 2) {
        const vendorRank = new Map();
        for (const pre of preItems) { for (const it of toArray(pre.pfItems)) { const vpId = it?.vendor_product; if (!vpId) continue; const vId = String(it?.vendor_id || it?.vendor?._id || (await cachedVendorId(vpId)) || ""); if (!vId) continue; vendorRank.set(vId, Math.min(vendorRank.get(vId) ?? 999, it.order ?? 999)); } }
        preferredVendorId = choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) || null;
    }

    // ===== PASS 2: Detailed calculation =====
    const groups = new Map();
    for (const pre of preItems) {
        const { item, itemId, sku, mapped_sku, used_sku, configCode, productTypeValue, matchedBy, sizeValue, colorValue } = pre;
        const { pfItems } = pre;

        const vendorSelection = await (async () => {
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
        const baseEach = Number(matched?.base_cost || 0);
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

        const rec = { transactionId: itemId, sku, used_sku: sku, configCode, productTypeValue: productTypeValue || null, selectedConfigBy: matchedBy || "unknown", sizeValue, colorValue, vendorProductId, vendorId, selectedOrder, itemDisplayName, baseEach, qty, eco: rate.eco, add: rate.add, shipProfile: rate.profile, matchedSku: matched?.sku || null, additionalCosts, totalAdditionalCost, status: "ok" };
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

module.exports = {
    importOrders,
    getListOrders,
    computeBaseCostForEtsyOrder,
    getEtsyOrderStatistics,
};