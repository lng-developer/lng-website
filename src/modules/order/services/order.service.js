const mongoose = require("mongoose");
const db = require("../../../models");
const Order = db.orderCustomProduct;
const OrderHistory = db.OrderHistory;
const costEngine = require("../../cost-engine/cost-engine.service");
const axios = require("axios");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { applyRulesToSku, buildRulesFromConfig } = require("../../catalog/utils/skuMigrate");

const ALLOWED_STATUSES = ["New", "Fulfilled", "Shipped", "Cancelled"];

class OrderService {
    /**
     * Helper to normalize status
     */
    normStatus(s) {
        return ALLOWED_STATUSES.includes(s) ? s : "New";
    }

    /**
     * Compute order status from items
     */
    computeOrderStatusFromItems(items = []) {
        const itemStatuses = items.map((i) => this.normStatus(i?.tracking_info?.status));
        const active = itemStatuses.filter((s) => s !== "Cancelled");
        if (active.length === 0) return "Cancelled";
        if (active.every((s) => s === "Shipped")) return "Shipped";
        const hasNew = active.includes("New");
        const hasFulfilled = active.includes("Fulfilled");
        const allFulfilledOrShipped = active.every(
            (s) => s === "Fulfilled" || s === "Shipped"
        );
        if (!hasNew && hasFulfilled && allFulfilledOrShipped) return "Fulfilled";
        return "New";
    }

    /**
     * Load active SKU mapping configs
     */
    async loadActiveSkuMappingConfigs() {
        const now = new Date();
        return db.SkuMappingConfig.find({
            is_active: true,
            $or: [{ valid_from: null }, { valid_from: { $lte: now } }],
            $or: [{ valid_to: null }, { valid_to: { $gte: now } }],
        })
            .sort({ priority: 1, updatedAt: -1 })
            .lean();
    }

    /**
     * Find active PSD Task by Listing
     */
    async findActivePsdTaskByListing(listingId) {
        return db.PsdTask.findOne({
            listing: listingId,
            status: { $nin: ["QC Passed", "Cancelled"] },
        }).select("_id status");
    }

    /**
     * Create new PSD Task
     */
    async createNewPsdTask({ listingId, sellerId, leaderId = null, note = "" }) {
        return db.PsdTask.create({
            listing: listingId,
            seller: sellerId || undefined,
            leader: leaderId || undefined,
            status: "New",
            history: [
                {
                    at: new Date(),
                    action: "auto_create_from_order",
                    from: "Unavailable",
                    to: "New",
                    note,
                },
            ],
        });
    }

    /**
     * Build next replacement Order ID (e.g., ORDER-ID-R1)
     */
    async buildNextReplaceOrderId(baseOrderId) {
        const base = String(baseOrderId).replace(/-R\d+$/i, "");
        const regex = new RegExp(`^${base}-R(\\d+)$`, "i");
        const exists = await Order.find(
            { orderId: { $regex: new RegExp(`^${base}-R\\d+$`, "i") } },
            { orderId: 1 }
        ).lean();

        if (!exists || exists.length === 0) return `${base}-R1`;

        let max = 0;
        for (const d of exists) {
            const m = String(d.orderId).match(regex);
            if (m && m[1]) max = Math.max(max, Number(m[1]));
        }
        return `${base}-R${max + 1}`;
    }
    /**
     * Get orders with enriched data and logs
     */
    async getOrders(query, user) {
        const orderHelper = require("../helpers/orderHelper");
        const {
            page = 1, perPage = 10,
            statuses, search, openCase, from, to,
            isNoCostCenter, includeLogs, logLimit = 5,
            financialStatus, sevenDayAlert, platform,
            noPsd, shippingType, shopName, userNull,
            invalidAddress, teamId, sellerId
        } = query;

        const { role = "", userId = "" } = user || {};
        const roles = {
            isAdmin: /^admin$/i.test(role),
            isSeller: /^seller$/i.test(role),
            isProduction: /^production$/i.test(role),
            isDesignLeader: /^design[-_\s]?leader$/i.test(role),
        };

        const ids = orderHelper.validateIds({ teamId, sellerId, userId });
        if (ids.error) throw new Error(ids.error);

        const initialMatch = orderHelper.buildInitialMatch(ids, roles, userId, userNull);
        const filters = orderHelper.buildFilters({
            statuses, search, openCase, from, to,
            isNoCostCenter: null, financialStatus, sevenDayAlert,
            platform, noPsd: null, shippingType
        });

        if (roles.isProduction) {
            const vendorFilter = await orderHelper.buildVendorFilter();
            if (vendorFilter === null) {
                return {
                    data: [], totalCount: 0, totalPages: 1, currentPage: 1,
                    includeLogs: orderHelper.normalizeBool(includeLogs),
                    logLimit: orderHelper.normalizeBool(includeLogs) ? Math.max(1, Math.min(parseInt(logLimit, 10) || 5, 50)) : 0,
                };
            }
            filters.push(vendorFilter);
        }

        if (orderHelper.normalizeBool(isNoCostCenter)) {
            filters.push({ $or: [{ base_cost: { $exists: false } }, { base_cost: null }, { base_cost: 0 }] });
            filters.push({ status: { $ne: "Cancelled" } });
        }

        if (orderHelper.normalizeBool(invalidAddress)) {
            filters.push({ "address_validation.isValid": false });
        }

        const wantNoPsd = orderHelper.normalizeBool(noPsd);
        if (wantNoPsd) {
            const listingIds = await orderHelper.getListingIdsNoPsd(db.listing);
            if (!listingIds.length) {
                return {
                    data: [], totalCount: 0, totalPages: 1, currentPage: parseInt(page, 10) || 1,
                    includeLogs: orderHelper.normalizeBool(includeLogs),
                    logLimit: orderHelper.normalizeBool(includeLogs) ? Math.max(1, Math.min(parseInt(logLimit, 10) || 5, 50)) : 0,
                };
            }
            filters.push({ items: { $elemMatch: { listingId: { $in: listingIds } } } });
            filters.push({ status: { $ne: "Cancelled" } });
        }

        const pipeline = await orderHelper.buildPipeline({
            initialMatch, filters, userId,
            teamObjectId: ids.teamObjectId,
            sellerObjectId: ids.sellerObjectId,
            shopName
        });

        const { orders, totalCount, limitNum } = await orderHelper.executePipeline(pipeline, page, perPage);
        const enrichedOrders = await orderHelper.enrichOrdersData(orders);

        const wantLogs = orderHelper.normalizeBool(includeLogs);
        const limitLogs = Math.max(1, Math.min(parseInt(logLimit, 10) || 5, 50));
        let ordersWithLogs = enrichedOrders;

        if (wantLogs && Array.isArray(enrichedOrders) && enrichedOrders.length) {
            const orderIdsArr = enrichedOrders.map(o => o.orderId).filter(Boolean);
            const logs = await OrderHistory.find({ orderId: { $in: orderIdsArr } })
                .sort({ createdAt: -1 })
                .select("orderId action description changes orderItemId userId userName userRole source createdAt")
                .lean();

            const logMap = new Map();
            for (const lg of logs) {
                const key = String(lg.orderId);
                if (!logMap.has(key)) logMap.set(key, []);
                const arr = logMap.get(key);
                if (arr.length < limitLogs) arr.push(lg);
            }

            ordersWithLogs = enrichedOrders.map(o => {
                const key = String(o.orderId || "");
                const historyDesc = logMap.get(key) || [];
                const historyAsc = [...historyDesc].reverse();
                return { ...o, latestLog: historyDesc[0] || null, history: historyAsc };
            });
        }

        const pageNum = parseInt(page, 10) || 1;
        const isAll = String(perPage).toLowerCase() === "all";

        return {
            data: ordersWithLogs,
            totalCount,
            totalPages: isAll ? 1 : Math.ceil(totalCount / limitNum),
            currentPage: pageNum,
            includeLogs: wantLogs,
            logLimit: wantLogs ? limitLogs : 0,
        };
    }

    /**
     * Get order statistics
     */
    async getStatistics(query, user) {
        const orderHelper = require("../../../helper/orderHelper");
        const {
            from, to, search, platform, userNull,
            noPsd, shippingType, shopName, teamId, openCase
        } = query;

        const { role = "", userId = "" } = user || {};
        const roles = {
            isAdmin: /^admin$/i.test(role),
            isSeller: /^seller$/i.test(role),
            isProduction: /^production$/i.test(role),
            isDesignLeader: /^design[-_\s]?leader$/i.test(role),
        };

        const ids = orderHelper.validateIds({ teamId, sellerId: null, userId });
        if (ids.error) throw new Error(ids.error);

        const baseMatch = orderHelper.buildInitialMatch(ids, roles, userId, userNull);
        const filters = orderHelper.buildFilters({
            statuses: null, search, openCase, from, to,
            isNoCostCenter: null, financialStatus: null, sevenDayAlert: null,
            platform, noPsd: null, shippingType
        });

        const team = await db.Team.findOne({ leaderId: userId }).select("_id").lean();
        if (team && baseMatch.sellerId) delete baseMatch.sellerId;

        if (ids.teamObjectId || team) {
            const tId = ids.teamObjectId || team._id;
            const members = await db.user.find({ team_id: tId }).select("_id").lean();
            filters.push({ sellerId: { $in: members.map(u => u._id) } });
        }

        if (roles.isProduction) {
            const vendorFilter = await orderHelper.buildVendorFilter();
            if (!vendorFilter) {
                return {
                    all: 0, new: 0, noCostCenter: 0, noPsd: 0, paymentPending: 0,
                    fulfilled: 0, shipped: 0, cancelled: 0, refund: 0, openCase: 0, invalidAddress: 0,
                };
            }
            filters.push(vendorFilter);
        }

        if (shopName) {
            const shop = await db.shop.findOne({ name: shopName }).lean();
            if (shop?._id) filters.push({ shopId: shop._id });
        }

        const listingIdsNoPsd = await orderHelper.getListingIdsNoPsd(db.listing);
        const wantNoPsdFilter = orderHelper.normalizeBool(noPsd);

        if (wantNoPsdFilter) {
            if (!listingIdsNoPsd.length) {
                return {
                    all: 0, new: 0, noCostCenter: 0, noPsd: 0, paymentPending: 0,
                    fulfilled: 0, shipped: 0, cancelled: 0, refund: 0, openCase: 0, invalidAddress: 0,
                };
            }
            filters.push({ items: { $elemMatch: { listingId: { $in: listingIdsNoPsd } } } });
            filters.push({ status: { $ne: "Cancelled" } });
        }

        const match = { ...baseMatch };
        if (filters.length) match.$and = filters;

        const NO_COST_CENTER = {
            $and: [
                { $or: [{ base_cost: { $exists: false } }, { base_cost: null }, { base_cost: 0 }] },
                { status: { $ne: "Cancelled" } },
            ],
        };

        const NO_PSD_MATCH = listingIdsNoPsd.length === 0
            ? { _id: null }
            : { $and: [{ items: { $elemMatch: { listingId: { $in: listingIdsNoPsd } } } }, { status: { $ne: "Cancelled" } }] };

        const [stat] = await Order.aggregate([
            { $match: match },
            {
                $facet: {
                    all: [{ $count: "c" }],
                    new: [{ $match: { status: "New" } }, { $count: "c" }],
                    noCostCenter: [{ $match: NO_COST_CENTER }, { $count: "c" }],
                    noPsd: [{ $match: NO_PSD_MATCH }, { $count: "c" }],
                    paymentPending: [{ $match: { financialStatus: "Pending" } }, { $count: "c" }],
                    fulfilled: [{ $match: { status: "Fulfilled" } }, { $count: "c" }],
                    shipped: [{ $match: { status: "Shipped" } }, { $count: "c" }],
                    cancelled: [{ $match: { status: "Cancelled" } }, { $count: "c" }],
                    refund: [{ $match: { status: "Refund" } }, { $count: "c" }],
                    openCase: [{ $match: { case: { $exists: true, $ne: [] } } }, { $count: "c" }],
                    invalidAddress: [{ $match: { "address_validation.isValid": false } }, { $count: "c" }],
                },
            },
            {
                $project: {
                    all: { $ifNull: [{ $arrayElemAt: ["$all.c", 0] }, 0] },
                    new: { $ifNull: [{ $arrayElemAt: ["$new.c", 0] }, 0] },
                    noCostCenter: { $ifNull: [{ $arrayElemAt: ["$noCostCenter.c", 0] }, 0] },
                    noPsd: { $ifNull: [{ $arrayElemAt: ["$noPsd.c", 0] }, 0] },
                    paymentPending: { $ifNull: [{ $arrayElemAt: ["$paymentPending.c", 0] }, 0] },
                    fulfilled: { $ifNull: [{ $arrayElemAt: ["$fulfilled.c", 0] }, 0] },
                    shipped: { $ifNull: [{ $arrayElemAt: ["$shipped.c", 0] }, 0] },
                    cancelled: { $ifNull: [{ $arrayElemAt: ["$cancelled.c", 0] }, 0] },
                    refund: { $ifNull: [{ $arrayElemAt: ["$refund.c", 0] }, 0] },
                    openCase: { $ifNull: [{ $arrayElemAt: ["$openCase.c", 0] }, 0] },
                    invalidAddress: { $ifNull: [{ $arrayElemAt: ["$invalidAddress.c", 0] }, 0] },
                },
            },
        ]);

        return stat || {
            all: 0, new: 0, noCostCenter: 0, noPsd: 0, paymentPending: 0,
            fulfilled: 0, shipped: 0, cancelled: 0, refund: 0, openCase: 0, invalidAddress: 0,
        };
    }

    /**
     * Update orders from XLSX file
     */
    async updateFromXlsx(file, user) {
        // Logic from updateOrdersFromXlsx
    }

    /**
     * Import order JSON (from Amazon customization)
     */
    async importOrderJson(data, user, context = {}) {
        const orderId = data.orderId;
        const orderItemId = data.orderItemId;
        const incomingSellerId = data.sellerId || null;
        const incomingShopId = data.shopId || null;

        const order = await Order.findOne({ orderId });
        if (!order) throw new Error("Order ID not found");

        const item = order.items.find(i => i.orderItemId === orderItemId);
        if (!item) throw new Error("OrderItem ID not found in Order");

        const asin = (data.asin || item.asin || "").trim();
        if (!asin) throw new Error("ASIN is required to link Listing");

        const baseImageFromPayload = data?.customizationData?.children?.[0]?.baseImage || {};
        const baseImageUrlForCreate = item?.baseImage?.imageUrl || baseImageFromPayload?.imageUrl ||
            (Array.isArray(data?.cloudinarySnapshots) ? data.cloudinarySnapshots[0] : "") || "";

        let listingDoc = await db.listing.findOne({ asin }).select("_id seller psd.status");
        let createdListing = false;

        if (!listingDoc) {
            if (!baseImageUrlForCreate) throw new Error("Cannot create Listing: product_image is required");

            listingDoc = await db.listing.create({
                asin,
                product_image: baseImageUrlForCreate,
                asin_type: "Normal",
                platform: "Amazon",
                seller: incomingSellerId || undefined,
                store: incomingShopId || undefined,
                template: {
                    design_product: "Design",
                    style: "Sweatshirt",
                    ...(data?.template || {})
                }
            });
            listingDoc = await db.listing.findById(listingDoc._id).select("_id seller psd.status");
            createdListing = true;
        }

        // Link listing to item
        if (!item.listingId || String(item.listingId) !== String(listingDoc._id)) {
            item.listingId = listingDoc._id;
            await order.save();
        }

        // Auto-create PSD Task
        let createdPsdTask = false;
        let psdTaskId = null;
        const currentPsdStatus = listingDoc?.psd?.status || "Unavailable";

        if (createdListing || currentPsdStatus === "Unavailable") {
            const existActive = await this.findActivePsdTaskByListing(listingDoc._id);
            if (!existActive) {
                const newTask = await this.createNewPsdTask({
                    listingId: listingDoc._id,
                    sellerId: listingDoc.seller || incomingSellerId || null,
                    note: `Order ${orderId} / Item ${orderItemId} triggers PSD task`
                });
                createdPsdTask = true;
                psdTaskId = String(newTask._id);
            }
        }

        if (item.customization || item.snapshotImage) {
            return {
                message: "Item already has customization data. Listing linked.",
                orderId, orderItemId, asin, listingLinked: true,
                listingId: String(item.listingId),
                psdStatus: currentPsdStatus,
                createdPsdTask, psdTaskId
            };
        }

        // Parse customization options
        let totalCustomizationPrice = 0;
        const customizationOptions = {};
        const options = data?.customizationData?.children?.[0]?.children?.[0]?.children || [];

        for (const opt of options) {
            const amount = opt?.optionSelection?.additionalCost?.amount || 0;
            totalCustomizationPrice += Number(amount);

            const label = opt?.label;
            const sel = opt?.optionSelection;

            switch (label) {
                case "Custom Name": customizationOptions.customName = opt?.inputValue || ""; break;
                case "Text Color": customizationOptions.textColor = sel?.name || ""; break;
                case "Photo Options": customizationOptions.photoOptions = sel?.name || ""; break;
                case "Photo Quality Enhancement": customizationOptions.photoQualityEnhancement = sel || null; break;
                case "Select Size": customizationOptions.sizeOption = sel || null; break;
                case "Select Pack": customizationOptions.packOption = sel || null; break;
                case "Priority Production": customizationOptions.priorityProduction = sel || null; break;
                default:
                    if (label?.startsWith("We would be grateful")) customizationOptions.thankYouMessage = sel || null;
                    break;
            }
        }

        const imageCustomization = options.find(opt => opt?.type === "PlacementContainerCustomization");
        const imageData = imageCustomization?.children?.[0]?.image || {};
        customizationOptions.photoUploaded = {
            imageName: imageData?.imageName || "",
            buyerFilename: imageData?.buyerFilename || ""
        };

        // Assign to item
        item.asin = asin;
        item.customization = customizationOptions;
        item.customizationData = data.customizationData || null;
        item.version3Data = data["version3.0"] || null;
        item.baseImage = {
            imageUrl: baseImageFromPayload?.imageUrl || "",
            width: baseImageFromPayload?.dimension?.width || null,
            height: baseImageFromPayload?.dimension?.height || null
        };
        item.snapshotImage = (Array.isArray(data?.cloudinarySnapshots) ? data.cloudinarySnapshots[0] : "") || "";
        item.svgFile = data?.customizationData?.children?.[0]?.svg || "";
        item.totalCustomizationPrice = totalCustomizationPrice;

        await order.save();

        return {
            message: "Order updated successfully!",
            orderId, orderItemId, asin, listingLinked: true,
            listingId: String(item.listingId),
            totalCustomizationPrice,
            psdStatus: currentPsdStatus,
            createdPsdTask, psdTaskId
        };
    }

    /**
     * Update order status
     */
    async updateStatus(orderId, status, user, context = {}) {
        if (!ALLOWED_STATUSES.includes(status)) {
            throw new Error("Invalid status value");
        }

        const order = await Order.findOne({ orderId });
        if (!order) {
            throw new Error("Order not found");
        }

        const oldStatus = order.status;
        if (oldStatus === status) return { message: "No change", orderId, newStatus: status };

        order.status = status;
        await order.save();

        await this.logHistory({
            orderDoc: order,
            action: "UPDATE_STATUS",
            description: `Order status changed from ${oldStatus} to ${status}`,
            changes: [{ field: "status", from: oldStatus, to: status }],
            user,
            context
        });

        return { orderId, oldStatus, newStatus: status };
    }

    /**
     * Update item tracking
     */
    async updateItemTracking(orderId, body, user, context = {}) {
        let { fulfillment, tracking, status, note } = body;

        const tFulfillment = fulfillment !== undefined ? String(fulfillment).trim() : undefined;
        const tTracking = tracking !== undefined ? String(tracking).trim() : undefined;
        const tNote = note !== undefined ? String(note) : undefined;
        const tStatus = status !== undefined ? String(status).trim() : undefined;

        if (tStatus && !ALLOWED_STATUSES.includes(tStatus)) {
            throw new Error("Invalid status");
        }

        if (tFulfillment === undefined && tTracking === undefined && tStatus === undefined && tNote === undefined) {
            throw new Error("No updatable fields provided");
        }

        let nextStatus;
        if (tStatus === "Cancelled") {
            nextStatus = "Cancelled";
        } else if (tTracking !== undefined && tTracking.length > 0) {
            nextStatus = "Shipped";
        } else {
            nextStatus = tStatus;
        }

        const beforeDoc = await Order.findOne({ orderId }, { orderId: 1, status: 1 }).lean();
        if (!beforeDoc) throw new Error("Order not found");

        const oldOrderStatus = beforeDoc.status;
        const $set = {};

        if (tFulfillment !== undefined) $set["items.$[].tracking_info.fulfillment"] = tFulfillment;
        if (tTracking !== undefined) $set["items.$[].tracking_info.tracking"] = tTracking;
        if (tNote !== undefined) $set["items.$[].tracking_info.note"] = tNote;
        $set["items.$[].tracking_info.updated_at"] = new Date();

        if (nextStatus !== undefined) {
            $set["items.$[].tracking_info.status"] = nextStatus;
            if (nextStatus === "Fulfilled" || nextStatus === "Shipped") {
                $set["items.$[].scale_status"] = "Complete";
                $set["scale_overall_status"] = "Sent";
            } else if (nextStatus === "Cancelled") {
                $set["items.$[].scale_status"] = "Failed";
                $set["scale_overall_status"] = "Cancelled";
            }
        }

        const docAfter = await Order.findOneAndUpdate({ orderId }, { $set }, { new: true });
        if (!docAfter) throw new Error("Order not found");

        const newOrderStatus = this.computeOrderStatusFromItems(docAfter.items);
        if (newOrderStatus !== docAfter.status) {
            await Order.updateOne({ _id: docAfter._id }, { $set: { status: newOrderStatus } });
            docAfter.status = newOrderStatus;
        }

        if (oldOrderStatus !== newOrderStatus) {
            await this.logHistory({
                orderDoc: docAfter,
                action: "UPDATE_STATUS",
                description: `Order status changed from ${oldOrderStatus} to ${newOrderStatus}`,
                changes: [{ field: "status", from: oldOrderStatus, to: newOrderStatus }],
                user,
                context
            });
        }

        return {
            orderId: docAfter.orderId,
            orderStatus: newOrderStatus,
            applied: { fulfillment: tFulfillment, tracking: tTracking, status: nextStatus, note: tNote }
        };
    }

    /**
     * Get order by ID (internal or orderId)
     */
    async getOrderById(id) {
        let order;
        if (mongoose.isValidObjectId(id)) {
            order = await Order.findById(id);
        } else {
            order = await Order.findOne({ orderId: id });
        }
        return order;
    }

    /**
     * Create replacement order
     */
    async createReplacementOrder(orderId, user, context = {}) {
        const originalOrder = await Order.findOne({ orderId });
        if (!originalOrder) throw new Error("Original order not found");

        const nextOrderId = await this.buildNextReplaceOrderId(orderId);

        // Clone the order
        const newOrderData = originalOrder.toObject();
        delete newOrderData._id;
        delete newOrderData.id;
        delete newOrderData.createdAt;
        delete newOrderData.updatedAt;

        newOrderData.orderId = nextOrderId;
        newOrderData.status = "New";
        newOrderData.scale_overall_status = "Need Scale";
        newOrderData.purchase_date = new Date();
        newOrderData.createdAt = new Date();

        // Reset items
        if (newOrderData.items && Array.isArray(newOrderData.items)) {
            newOrderData.items.forEach(item => {
                item.tracking_info = {
                    fulfillment: "",
                    tracking: "",
                    status: "New",
                    note: "",
                    updated_at: new Date()
                };
                item.scale_status = "Need Scale";
                item.fulfillment_file = new Map();
            });
        }

        const replacementOrder = new Order(newOrderData);
        await replacementOrder.save();

        await this.logHistory({
            orderDoc: replacementOrder,
            action: "CREATE_ORDER",
            description: `Replacement order created from ${orderId}`,
            user,
            context
        });

        // Also log on original order
        await this.logHistory({
            orderDoc: originalOrder,
            action: "OTHER",
            description: `Created replacement order: ${nextOrderId}`,
            user,
            context
        });

        return replacementOrder;
    }

    /**
     * Internal address validation using Smarty
     */
    async validateAddressWithSmarty(address) {
        try {
            const response = await axios.get(
                "https://us-street.api.smarty.com/street-address",
                {
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
    }

    /**
     * Validate address by Order ID
     */
    async validateAddressByOrderId(orderId) {
        const order = await Order.findOne({ orderId });
        if (!order) throw new Error("Order not found");
        const address = order.customer_infor;
        if (!address) throw new Error("Order does not have customer_infor");

        const result = await this.validateAddressWithSmarty(address);
        order.address_validation = result;
        await order.save();
        return { orderId, addressValid: result.isValid, smartyResponse: result.smartyResponse };
    }

    /**
     * Validate invalid addresses in batch
     */
    async validateInvalidAddressesBatch(query) {
        const { shopId, from, to, status = "New", force, limit = 200, concurrency = 5 } = query;
        const nLimit = Math.min(Math.max(parseInt(limit) || 200, 1), 1000);
        const filter = { customer_infor: { $exists: true, $ne: null } };
        if (shopId) filter.shopId = new mongoose.Types.ObjectId(shopId);
        if (status) filter.status = status;
        if (from || to) {
            filter.purchase_date = {};
            if (from) filter.purchase_date.$gte = new Date(from);
            if (to) filter.purchase_date.$lte = new Date(to);
        }
        if (!String(force) === "true") {
            filter.$or = [
                { address_validation: { $exists: false } },
                { "address_validation.isValid": false },
                { "address_validation.smartyResponse.error": { $exists: true, $ne: null } }
            ];
        }

        const orders = await Order.find(filter).limit(nLimit).lean();
        const results = [];
        // Sequential for simplicity in service, or use a pool lib if needed
        for (const o of orders) {
            try {
                const res = await this.validateAddressByOrderId(o.orderId);
                results.push({ orderId: o.orderId, checked: true, addressValid: res.addressValid });
            } catch (err) {
                results.push({ orderId: o.orderId, checked: false, error: err.message });
            }
        }
        return results;
    }

    /**
     * Update from XLSX (Skeleton only due to size, focusing on core logic move)
     */
    async updateFromXlsx(file, body, user) {
        if (!file) throw new Error("No file uploaded");
        // Actual implementation would be very large, similar to the controller logic
        // We'll proxy this or implement the core bulk write part
        return { message: "XLSX Update started (not fully implemented in modular service yet)" };
    }

    async computeBaseCost(orderId, user, context = {}) {
        const order = await Order.findOne({ orderId });
        if (!order) throw new Error("Order not found");

        const result = await costEngine.computeBaseCost(order, "amazon");

        // Update order with total base cost
        order.base_cost = result.totalBaseCost;
        // Optionally update item-level details if needed in the future
        await order.save();

        await this.logHistory({
            orderDoc: order,
            action: "UPDATE_COST",
            description: `Recomputed base cost: ${result.totalBaseCost}`,
            user,
            context
        });

        return result;
    }

    /**
     * Helper for logging order history
     */
    async logHistory({ orderDoc, action, description, changes, user, context }) {
        try {
            const history = new OrderHistory({
                order: orderDoc._id,
                orderId: orderDoc.orderId,
                action,
                description,
                changes,
                userId: user?._id || user?.id,
                userName: user?.name || user?.username,
                userRole: user?.role,
                source: context?.source || "PORTAL",
                ip: context?.ip,
                userAgent: context?.userAgent,
            });
            await history.save();
        } catch (error) {
            console.error("Log order history error:", error);
        }
    }
}

module.exports = new OrderService();

