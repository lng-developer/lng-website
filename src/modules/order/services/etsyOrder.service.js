const db = require("../../../models");
const EtsyOrder = db.EtsyOrder;
const EtsyListing = db.EtsyListing;
const User = db.user;
const Store = db.shop;
const ConfigOptionMapping = db.configOptionMapping;
const fs = require("fs");
const { parse } = require("csv-parse");
const axios = require("axios");
const mongoose = require("mongoose");
const costEngine = require("../../cost-engine/cost-engine.service");

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
    const parts = String(raw).split(",").map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
        const idx = p.indexOf(":");
        if (idx === -1) continue;
        out[p.slice(0, idx).trim()] = p.slice(idx + 1).trim();
    }
    return out;
};

class EtsyOrderService {
    async importOrders(files, shopId) {
        if (!shopId || !mongoose.Types.ObjectId.isValid(shopId)) {
            throw new Error("Valid shopId is required");
        }

        const stats = {
            ordersUpserted: 0,
            itemsProcessed: 0,
            itemsCreated: 0,
            sellerLinked: 0,
        };

        for (const file of files) {
            const rows = await this.readCsv(file.path);
            const type = this.detectFileType(rows);

            if (type === "orders") {
                const bulkOps = rows.map((row) => {
                    if (!row["Order ID"]) return null;
                    const orderValue = toNumber(row["Order Value"]) || 0;
                    const shipping = toNumber(row["Shipping"]) || 0;
                    const orderTotal = toNumber(row["Order Total"]) || 0;
                    const discountAmount = toNumber(row["Discount Amount"]) || 0;
                    const cardProcessingFees = toNumber(row["Card Processing Fees"]) || 0;
                    const orderNet = toNumber(row["Order Net"]) || 0;
                    let salesTax = toNumber(row["Sales Tax"]) || 0;

                    if (salesTax === 0 && orderTotal > 0) {
                        const computedTax = orderTotal - (orderValue + shipping - discountAmount);
                        if (computedTax > 0) salesTax = Number(computedTax.toFixed(2));
                    }

                    const orderTotalExcludingTax = orderTotal - salesTax;
                    const exchangeRate = 26000;
                    const fixedFeeUsd = 11500 / exchangeRate;
                    const calculatedFee = (0.065 * orderTotalExcludingTax) + (0.045 * orderTotal + fixedFeeUsd) + (0.0124 * orderTotalExcludingTax);

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
                                    "totals.discountAmount": discountAmount,
                                },
                            },
                            upsert: true,
                        },
                    };
                }).filter(Boolean);

                if (bulkOps.length) {
                    await EtsyOrder.bulkWrite(bulkOps, { ordered: false });
                    stats.ordersUpserted += bulkOps.length;
                }
            }

            if (type === "items") {
                const affectedOrders = new Set();
                const allSkus = rows.map((r) => r["SKU"]).filter(Boolean);
                const uniqueSkus = [...new Set(allSkus)];
                const listings = await EtsyListing.find({ SKU: { $in: uniqueSkus } }).lean();
                const skuImageMap = new Map();
                for (const listing of listings) {
                    if (listing.SKU && listing.IMAGE1) skuImageMap.set(listing.SKU, listing.IMAGE1);
                }

                for (const row of rows) {
                    const orderId = row["Order ID"];
                    if (!orderId) continue;
                    affectedOrders.add(orderId);

                    await EtsyOrder.updateOne({ orderId, shopId }, { $setOnInsert: { orderId, shopId, items: [] } }, { upsert: true });

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
                        await EtsyOrder.updateOne({ orderId, shopId }, { $push: { items: itemDoc } });
                    }

                    const sellerCode = this.getSellerCodeFromSku(itemDoc.sku);
                    if (sellerCode) {
                        await this.fillSellerIfMissing(orderId, shopId, sellerCode);
                        stats.sellerLinked += 1;
                    }
                    stats.itemsProcessed += 1;
                }

                let computedCount = 0;
                for (const oid of affectedOrders) {
                    await EtsyOrder.updateOne({ orderId: oid, shopId }, [{ $set: { numberOfItems: { $size: { $ifNull: ["$items", []] } } } }]);
                    const order = await EtsyOrder.findOne({ orderId: oid, shopId });
                    await this.validateAddressIfNeeded(order);
                    try {
                        if (order && Array.isArray(order.items) && order.items.length > 0) {
                            await this.calculateEtsyCost(order);
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
        return stats;
    }

    async getListOrders(query) {
        const { page = 1, limit = 20, from, to, search, platform, userNull, noPsd, shippingType, shopName, teamId, openCase, status, isNoCostCenter, sortBy = "saleDate", sortOrder = "desc" } = query;
        const filter = {};
        if (status) filter.status = status;
        if (shippingType) filter.shipping_type = shippingType;

        if (shopName) {
            const shops = await Store.find({ name: new RegExp(shopName, "i") }).select("_id").lean();
            filter.shopId = { $in: shops.map((s) => s._id) };
        }

        if (teamId) {
            const teamShops = await Store.find({ team: teamId }).select("_id").lean();
            const teamShopIds = teamShops.map((s) => s._id);
            if (filter.shopId) {
                const existing = filter.shopId.$in || [filter.shopId];
                filter.shopId = { $in: existing.filter((id) => teamShopIds.some((tid) => tid.equals(id))) };
            } else {
                filter.shopId = { $in: teamShopIds };
            }
        }

        if (userNull === "true") filter["seller.sellerId"] = { $in: [null, undefined] };
        if (from || to) {
            filter.saleDate = {};
            if (from) filter.saleDate.$gte = new Date(from);
            if (to) filter.saleDate.$lte = new Date(to);
        }

        if (isNoCostCenter === "true") {
            filter.$and = [...(filter.$and || []), { $or: [{ base_cost: { $exists: false } }, { base_cost: null }, { base_cost: 0 }] }, { status: { $ne: "Cancelled" } }];
        }

        if (search) {
            const regex = new RegExp(search, "i");
            filter.$or = [{ orderId: regex }, { "buyer.fullName": regex }, { "buyer.userId": regex }, { "items.sku": regex }, { "items.itemName": regex }, { "items.transactionId": regex }, { "seller.sellerCode": regex }, { "shipping.city": regex }, { "shipping.state": regex }, { "shipping.country": regex }];
        }

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(200, parseInt(limit));
        const skip = (pageNum - 1) * limitNum;
        const sortField = ["saleDate", "createdAt", "updatedAt", "base_cost", "numberOfItems", "orderId", "status"].includes(sortBy) ? sortBy : "saleDate";
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

        const vpIdSet = new Set();
        rawData.forEach((order) => order.items?.forEach((item) => item.cost_breakdown?.vendorProductId && vpIdSet.add(item.cost_breakdown.vendorProductId)));

        const vpMap = new Map();
        if (vpIdSet.size > 0) {
            const VendorProduct = mongoose.model("VendorProduct");
            const Vendor = mongoose.model("Vendor");
            const vpDocs = await VendorProduct.find({ _id: { $in: [...vpIdSet] } }).lean();
            const vendorDocs = await Vendor.find({ _id: { $in: [...new Set(vpDocs.map((vp) => String(vp.vendor_id)))] } }).lean();
            const vendorMap = new Map(vendorDocs.map((v) => [String(v._id), v.name]));
            vpDocs.forEach((vp) => vpMap.set(String(vp._id), { vendorProductId: String(vp._id), vendorProductDisplayName: `${vendorMap.get(String(vp.vendor_id)) || "Unknown"} - ${vp.product_name || ""}` }));
        }

        const data = rawData.map((order) => ({
            orderId: order.orderId,
            customer_infor: { name: order.buyer?.fullName || order.shipping?.name || "", address: order.shipping?.address1 || "", address_2: order.shipping?.address2 || "", city: order.shipping?.city || "", state: order.shipping?.state || "", zip_code: order.shipping?.zipcode || "", country: order.shipping?.country || "" },
            status: order.status || "New",
            purchase_date: order.saleDate || null,
            createdAt: order.createdAt || null,
            shopName: order.shopId?.name || "",
            shipping_type: order.shipping_type || "Standard",
            items: (order.items || []).map((item) => {
                let cost_center = item.cost_breakdown?.vendorProductId ? { ...vpMap.get(String(item.cost_breakdown.vendorProductId)), sizeValue: item.cost_breakdown.sizeValue || null, colorValue: item.cost_breakdown.colorValue || null } : null;
                let version3Data = item.variations ? Object.entries(item.variations).map(([label, value]) => ({ label, value: value || "" })) : null;
                return { orderItemId: item.transactionId || "", sku: item.sku || "", title: item.itemName || "", quantity: item.quantity || 1, version3Data, baseImageUrl: item.baseImage?.imageUrl || "", listingId: item.listingId || null, cost_center, tracking_info: item.tracking_info || {}, scale_status: item.scale_status || null };
            }),
            base_cost: order.base_cost || 0,
            address_validation: order.address_validation?.isValid ?? null,
            seller: order.seller?.sellerId ? { _id: order.seller.sellerId._id, full_name: order.seller.sellerId.full_name, email: order.seller.sellerId.email } : null,
            numberOfItems: order.numberOfItems || 0,
        }));

        return { data, totalCount: total, totalPages: Math.ceil(total / limitNum), currentPage: pageNum };
    }

    async deleteOrder(id) {
        return await EtsyOrder.findByIdAndDelete(id);
    }

    /* ================== HELPERS ================== */
    readCsv(filePath) {
        return new Promise((resolve, reject) => {
            const rows = [];
            fs.createReadStream(filePath).pipe(parse({ columns: true, skip_empty_lines: true, bom: true })).on("data", (row) => rows.push(row)).on("error", reject).on("end", () => resolve(rows));
        });
    }

    detectFileType(rows) {
        if (!rows.length) return "unknown";
        const headers = Object.keys(rows[0]);
        if (headers.includes("Transaction ID")) return "items";
        if (headers.includes("Buyer User ID")) return "orders";
        return "unknown";
    }

    getSellerCodeFromSku(sku) {
        if (!sku) return null;
        const s = String(sku).trim();
        return s.split("-")[0]?.trim() || null;
    }

    async fillSellerIfMissing(orderId, shopId, sellerCode) {
        if (!sellerCode) return;
        const user = await User.findOne({ employee_id: sellerCode }).select("_id employee_id").lean();
        const missing = (field) => ({ $or: [{ $eq: [{ $ifNull: [field, null] }, null] }, { $eq: [field, ""] }] });
        const pipeline = [{ $set: { "seller.sellerCode": { $cond: [missing("$seller.sellerCode"), sellerCode, "$seller.sellerCode"] }, "seller.sellerId": user?._id ? { $cond: [missing("$seller.sellerId"), user._id, "$seller.sellerId"] } : "$seller.sellerId" } }];
        await EtsyOrder.updateOne({ orderId, shopId }, pipeline, { upsert: true });
    }

    async validateAddressIfNeeded(orderDoc) {
        if (!orderDoc || (orderDoc.shipping?.country !== "United States" && orderDoc.shipping?.country !== "US")) return;
        if (orderDoc.address_validation?.isValid === null && orderDoc.address_validation?.smartyResponse === null) {
            const result = await validateAddressWithSmarty({ address: orderDoc.shipping?.address1, address_2: orderDoc.shipping?.address2, city: orderDoc.shipping?.city, state: orderDoc.shipping?.state, zip_code: orderDoc.shipping?.zipcode });
            orderDoc.address_validation = result;
            await orderDoc.save();
        }
    }

    async calculateEtsyCost(order) {
        const cache = costEngine.createCacheContext({ platform: "etsy" });
        const stagedItems = [], preItems = [], candidateSetsPerItem = [];

        for (const item of order.items) {
            const { usedSku, originalSku, mappedSku } = costEngine.getSkuForCost(item);
            const configCode = costEngine.parseConfigCodeFromSKU(usedSku);
            if (!configCode) { stagedItems.push({ transactionId: item.transactionId, status: "failed", reason: "No config code" }); continue; }

            const labelValueMap = costEngine.extractLabelValueMapFromEtsyItem(item);
            const { cfg, productTypeValue, matchedBy, reason } = await cache.cachedSelectConfig(configCode, labelValueMap);
            if (!cfg) { stagedItems.push({ transactionId: item.transactionId, status: "failed", reason }); continue; }

            const sizeMap = await cache.cachedMapOption({ configCode, key: "size", rawValue: costEngine.pickValueByKeys(labelValueMap, cfg.customize_size_key || []) });
            const colorMap = await cache.cachedMapOption({ configCode, key: "color", rawValue: costEngine.pickValueByKeys(labelValueMap, cfg.customize_color_key || []) });

            let pfItems = costEngine.toArray(cfg?.product_for_seller?.items).filter(Boolean);
            pfItems = costEngine.filterEbmPfItems(configCode, pfItems);
            if (!pfItems.length) { stagedItems.push({ transactionId: item.transactionId, status: "failed", reason: "No pfItems" }); continue; }

            preItems.push({ item, itemId: item.transactionId, sku: originalSku, mapped_sku: mappedSku, used_sku: usedSku, configCode, productTypeValue, matchedBy, sizeValue: sizeMap.value, colorValue: colorMap.value, pfItems });
            const vendorSet = new Set();
            for (const pf of pfItems) {
                const vpId = pf?.vendor_product; if (!vpId) continue;
                const candidates = await cache.cachedVendorCostCenters(vpId);
                if (costEngine.findBestCostCenter(candidates, sizeMap.value, colorMap.value, { strict: true })) {
                    const vId = String(pf?.vendor_id || pf?.vendor?._id || (await cache.cachedVendorId(vpId)) || "");
                    if (vId) vendorSet.add(vId);
                }
            }
            candidateSetsPerItem.push(vendorSet);
        }

        let preferredVendorId = null;
        if (preItems.length >= 2) {
            const vendorRank = new Map();
            for (const pre of preItems) { for (const it of pre.pfItems) { const vpId = it.vendor_product; if (!vpId) continue; const vId = String(it.vendor_id || it.vendor?._id || (await cache.cachedVendorId(vpId)) || ""); vendorRank.set(vId, Math.min(vendorRank.get(vId) ?? 999, it.order ?? 999)); } }
            preferredVendorId = costEngine.choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank);
        }

        const perItemResults = [], groups = new Map();
        for (const pre of preItems) {
            const selection = await (async () => {
                const resolved = [];
                for (const it of pre.pfItems) { const vpId = it.vendor_product; if (!vpId) continue; resolved.push({ ...it, __vendorId: String(it.vendor_id || it.vendor?._id || (await cache.cachedVendorId(vpId)) || ""), __vendorProductId: vpId }); }
                const checkList = preferredVendorId ? resolved.filter(x => x.__vendorId === preferredVendorId) : resolved;
                for (const cItem of (checkList.length ? checkList : resolved)) {
                    const candidates = await cache.cachedVendorCostCenters(cItem.__vendorProductId);
                    let hit = costEngine.findBestCostCenter(candidates, pre.sizeValue, pre.colorValue, { strict: true }) || costEngine.findBestCostCenter(candidates, pre.sizeValue, pre.colorValue, { strict: false });
                    if (hit && Number(hit.base_cost) > 0) return { success: true, vendorProductId: cItem.__vendorProductId, matched: hit, vendorId: cItem.__vendorId, itemDisplayName: cItem.display_name };
                }
                return { success: false, reason: "No matching vendor product" };
            })();

            if (!selection.success) { stagedItems.push({ transactionId: pre.itemId, status: "failed", reason: selection.reason }); continue; }
            const { vendorProductId, matched, vendorId, itemDisplayName } = selection;
            const rate = (matched.international && (matched.international.economy != null || matched.international.additional != null)) ? { eco: Number(matched.international.economy ?? 0), add: Number(matched.international.additional ?? 0), profile: "international" } : { eco: 0, add: 0, profile: "international" };
            const { additionalCosts, totalAdditionalCost } = costEngine.resolveAdditionalCosts(pre.configCode, matched);
            const rec = { ...pre, vendorProductId, vendorId, itemDisplayName, baseEach: Number(matched.base_cost), qty: Math.max(1, Number(pre.item.quantity)), eco: rate.eco, add: rate.add, shipProfile: rate.profile, matchedSku: matched.sku, additionalCosts, totalAdditionalCost, status: "ok" };
            stagedItems.push(rec);
            const g = groups.get(`${vendorId}::${rate.profile}`) || { vendorId, shipProfile: rate.profile, items: [], economyMax: 0 };
            g.items.push(rec); g.economyMax = Math.max(g.economyMax, rate.eco); groups.set(`${vendorId}::${rate.profile}`, g);
        }

        for (const rec of stagedItems) {
            if (rec.status !== "ok") { perItemResults.push(rec); continue; }
            perItemResults.push({ transactionId: rec.transactionId, sku: rec.sku, configCode: rec.configCode, sizeValue: rec.sizeValue, colorValue: rec.colorValue, vendorProductId: rec.vendorProductId, vendorId: rec.vendorId, base_cost_each: rec.baseEach, quantity: rec.qty, total_additional_cost_per_item: rec.totalAdditionalCost * rec.qty, status: "ok", shipping_international_economy: 0, shipping_international_additional_units: 0 });
        }

        for (const g of groups.values()) {
            let remainEco = 1, remainAdd = g.items.reduce((s, it) => s + it.qty, 0) - 1;
            for (const it of g.items.sort((a, b) => b.eco - a.eco)) {
                const out = perItemResults.find(r => r.transactionId === it.transactionId && r.status === "ok"); if (!out) continue;
                const ecoHere = (remainEco > 0 && it.qty > 0) ? g.economyMax : 0;
                if (ecoHere > 0) remainEco = 0;
                const addUnits = Math.max(0, it.qty - (ecoHere > 0 ? 1 : 0));
                out.shipping_international_economy += ecoHere;
                out.shipping_international_additional_units += addUnits;
                out.shipping_international_additional_rate = it.add;
                out.base_cost_total_for_item_including_shipping = Number((it.baseEach * it.qty + it.totalAdditionalCost * it.qty + ecoHere + addUnits * it.add).toFixed(2));
            }
        }

        order.base_cost = Number(perItemResults.reduce((s, r) => s + (r.base_cost_total_for_item_including_shipping || 0), 0).toFixed(2));
        order.cost_breakdown = { items: perItemResults.filter(r => r.status === "ok") };
        for (const item of order.items) {
            const breakdown = perItemResults.find(r => r.transactionId === item.transactionId);
            if (breakdown) item.cost_breakdown = breakdown;
        }
        await order.save();
    }
}

async function validateAddressWithSmarty(address) {
    try {
        const response = await axios.get("https://us-street.api.smarty.com/street-address", { timeout: 8000, params: { "auth-id": process.env.SMARTY_AUTH_ID, "auth-token": process.env.SMARTY_AUTH_TOKEN, street: address.address, street2: address.address_2, city: address.city, state: address.state, zipcode: address.zip_code } });
        return response.data.length > 0 ? { isValid: true, smartyResponse: response.data[0] } : { isValid: false, smartyResponse: null };
    } catch (err) { return { isValid: false, smartyResponse: { error: err.message } }; }
}

module.exports = new EtsyOrderService();

