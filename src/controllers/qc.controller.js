// controllers/qc.controller.js
const axios = require("axios");
const mongoose = require("mongoose");
const db = require("../models");
const { logOrderHistory } = require("../service/orderHistoryLogger");
const { logOrderLifecycleEvent } = require("../service/orderLifecycleLogger");
const { buildOrderLifecyclePayload } = require("../service/orderLifecycleContext");
const OrderCustomProduct = db.orderCustomProduct;
const VendorProduct = db.vendorProduct;
const Listing = db.listing;

// ====== CONSTANTS & HELPERS ======
const KNOWN = [
  "Need Scale",
  "Pending",
  "Ready",
  "Sent",
  "Failed",
  "QC Rejected",
  "Cancelled",
  "Address Invalid",
];

// All = chỉ các trạng thái đang hoạt động trong quy trình QC
const ACTIVE = ["Pending", "Sent", "QC Rejected", "Ready", "Address Invalid"];
const PRODUCTION_VENDOR_OVERRIDE_KEY = "lng";

const hasRole = (userRole, target) => {
  if (!userRole) return false;
  const normalizeRole = (s) =>
    String(s || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  const wanted = normalizeRole(target);

  if (Array.isArray(userRole)) {
    return userRole.some((role) => normalizeRole(role) === wanted);
  }
  if (typeof userRole === "object" && Array.isArray(userRole.roles)) {
    return userRole.roles.some((role) => normalizeRole(role) === wanted);
  }
  return normalizeRole(userRole) === wanted;
};

const canon = (s) => {
  const t = String(s || "").trim();
  if (!t) return "";
  if (/^complete$/i.test(t)) return "Ready";
  if (/^qc\s*reject(?:ed)?$/i.test(t)) return "QC Rejected";
  if (/^addr(?:ess)?\s*invalid$/i.test(t)) return "Address Invalid";
  return t;
};

const toPlainObject = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value.toObject === "function") return value.toObject();
  if (typeof value === "object") return value;
  return {};
};

const normalizeFulfillmentFile = (value) => {
  const plain = toPlainObject(value);
  return plain && typeof plain === "object" ? plain : {};
};

const withProductionVendorOverride = (costBreakdown) => {
  const costCenter = toPlainObject(costBreakdown);
  if (costCenter.vendorProductId) return costCenter;
  return {
    ...costCenter,
    vendorKey: PRODUCTION_VENDOR_OVERRIDE_KEY,
    vendor_mapping_override: true,
    vendor_mapping_override_reason: "missing portal vendor mapping",
  };
};

const getFullSizeEtsyImageUrl = (src) => {
  if (typeof src !== "string") return src;
  return src.replace(/il_\d+x(?:N|\d+)/, "il_fullxfull");
};

const toIsoDateStringOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const isCanceledStatus = (status) => /^(canceled|cancelled)$/i.test(String(status || "").trim());
const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAmazonOrderId = (value = "") => /^\d{3}-\d{7}-\d{7}(?:-R\d+)?$/i.test(String(value).trim());

const extractVersion3Data = (item) => {
  const surfaces = item.version3Data?.customizationInfo?.surfaces || [];
  return surfaces.flatMap((surface) =>
    (surface.areas || []).map((area) => ({
      label: area.label || area.name || "",
      value: area.optionValue || area.text || area.numberValue || "",
    }))
  );
};

const buildPortalPayload = (orders) => ({
  data: (Array.isArray(orders) ? orders : []).map((order) => {
    const customer = toPlainObject(order.customer_infor);
    const shopName = order.shopId?.name || null;
    const seller = order.sellerId
      ? {
          _id: order.sellerId._id,
          full_name: order.sellerId.full_name,
          email: order.sellerId.email,
        }
      : null;
    const scaledBy = order.scaleId
      ? {
          _id: order.scaleId._id,
          full_name: order.scaleId.full_name,
          email: order.scaleId.email,
        }
      : null;

    return {
      orderId: order.orderId,
      merchantId: order.merchantId || null,
      marketplaceId: order.marketplaceId || null,
      customer_infor: {
        email: customer.email || "",
        name: customer.name || "",
        address: customer.address || "",
        address_2: customer.address_2 || "",
        city: customer.city || "",
        state: customer.state || customer.province || "",
        zip_code: customer.zip_code || "",
        country: customer.country || "US",
        phone_number: customer.phone_number || "",
      },
      status: "Fulfilled",
      purchase_date: toIsoDateStringOrNull(order.purchase_date),
      shopName,
      shipping_type: order.shipping_type || "Standard",
      items: (Array.isArray(order.items) ? order.items : []).map((item) => {
        const listingDoc =
          item.listingId && typeof item.listingId === "object"
            ? toPlainObject(item.listingId)
            : null;
        const listingId = listingDoc?._id || item.listingId || null;
        const snapshotImageUrl = item.snapshotImageUrl || item.snapshotImage || "";
        const baseImageUrl = item.baseImageUrl || item.baseImage?.imageUrl || listingDoc?.product_image || "";

        return {
          orderItemId: item.orderItemId || "",
          sku: item.sku || "",
          title: item.title || "",
          quantity: item.quantity || 1,
          asin: item.asin || "",
          version3Data: extractVersion3Data(item),
          customized_url: item.customized_url || "",
          baseImageUrl,
          snapshotImage: snapshotImageUrl,
          snapshotImageUrl,
          fulfillment_file: normalizeFulfillmentFile(item.fulfillment_file),
          listingId: listingId ? String(listingId) : "",
          listing: listingDoc
            ? {
                asin_type: listingDoc.asin_type || null,
                product_image: listingDoc.product_image || null,
                psd: listingDoc.psd || null,
              }
            : {},
          cost_center: withProductionVendorOverride(item.cost_breakdown),
          scale_status: "Pending",
          qc_note: "",
        };
      }),
      scaledBy,
      seller,
    };
  }),
});

const validatePortalPayload = (payload) => {
  const errors = [];
  if (!Array.isArray(payload?.data)) {
    errors.push({ field: "data", message: "data must be an array" });
    return errors;
  }

  payload.data.forEach((order, orderIndex) => {
    if (!String(order?.orderId || "").trim()) {
      errors.push({
        field: `data[${orderIndex}].orderId`,
        message: "orderId is required",
      });
    }

    if (!order.customer_infor || typeof order.customer_infor !== "object" || Array.isArray(order.customer_infor)) {
      errors.push({
        field: `data[${orderIndex}].customer_infor`,
        message: "customer_infor must be an object",
      });
    }

    if (!Array.isArray(order.items)) {
      errors.push({
        field: `data[${orderIndex}].items`,
        message: "items must be an array",
      });
      return;
    }

    order.items.forEach((item, itemIndex) => {
      if (!String(item?.orderItemId || "").trim()) {
        errors.push({
          field: `data[${orderIndex}].items[${itemIndex}].orderItemId`,
          message: "orderItemId is required",
        });
      }
    });
  });

  return errors;
};

const getPortalError = (error) => {
  if (error.response) {
    return {
      status: error.response.status || 502,
      error: error.response.data || error.message,
    };
  }
  return { status: 502, error: error.message };
};

const normalizeOrderIds = (rawOrderIds) => {
  if (!Array.isArray(rawOrderIds) || rawOrderIds.length === 0) {
    return null;
  }

  return [
    ...new Set(
      rawOrderIds
        .map((orderId) =>
          typeof orderId === "string" ? orderId.trim() : String(orderId || "").trim()
        )
        .filter(Boolean)
    ),
  ];
};

const serializeForPlatform = (value) => {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, mapValue]) => [
        key,
        serializeForPlatform(mapValue),
      ])
    );
  }
  if (Array.isArray(value)) return value.map(serializeForPlatform);
  if (typeof value.toObject === "function") {
    return serializeForPlatform(
      value.toObject({
        depopulate: false,
        flattenMaps: true,
        versionKey: false,
      })
    );
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, objectValue]) => typeof objectValue !== "function")
        .map(([key, objectValue]) => [key, serializeForPlatform(objectValue)])
    );
  }
  return value;
};

const resolvePortalSourceChannel = (order, fallbackSourceChannel = "UNKNOWN") => {
  const explicitSourceCandidates = [
    order?.sourceChannel,
    order?.source_channel,
    order?.platform,
    order?.channel,
    order?.source,
    order?.orderType,
  ].filter(Boolean);
  const candidates = [
    ...explicitSourceCandidates,
    order?.shopName,
    order?.shopId?.name,
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());

  if (candidates.some((value) => value.includes("etsy"))) return "ETSY";
  if (
    candidates.some((value) => value.includes("amazon")) ||
    order?.merchantId ||
    order?.marketplaceId
  ) {
    return "AMAZON";
  }
  if (explicitSourceCandidates.length > 0) return "UNKNOWN";

  return fallbackSourceChannel;
};

const serializePortalOrderForPlatform = (order, fallbackSourceChannel = "UNKNOWN") => {
  const serializedOrder = serializeForPlatform(order);

  return {
    ...serializedOrder,
    source: "portal",
    sourceChannel: resolvePortalSourceChannel(serializedOrder, fallbackSourceChannel),
  };
};

const getFulfillmentFileKeys = (value) => {
  const fileMap = normalizeFulfillmentFile(value);
  return Object.keys(fileMap).filter((key) => fileMap[key]);
};

const buildFulfillmentPlatformPayloadPreview = (payload) =>
  (Array.isArray(payload?.data) ? payload.data : []).flatMap((order) =>
    (Array.isArray(order.items) ? order.items : []).map((item) => ({
      orderId: order.orderId,
      itemId: item.orderItemId || item.transactionId || "",
      sku: item.sku || "",
      hasSnapshotImage: Boolean(item.snapshotImageUrl || item.snapshotImage),
      hasBaseImageUrl: Boolean(item.baseImageUrl),
      fulfillmentFileKeys: getFulfillmentFileKeys(item.fulfillment_file || item.fulfillmentFile),
      vendorProductId: item.cost_center?.vendorProductId || null,
      vendorKey: item.cost_center?.vendorKey || null,
      vendorMappingOverride: item.cost_center?.vendor_mapping_override === true,
    }))
  );

const parseAxiosRequestPayload = (data) => {
  if (!data) return {};
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch (_) {
      return {};
    }
  }
  return typeof data === "object" ? data : {};
};

const toSafeFulfillmentSummary = (data, fallbackSuccess = true) => {
  const source = data && typeof data === "object" ? data : {};
  const numberOrZero = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  };
  const safeErrors = (value) =>
    Array.isArray(value)
      ? value.map((error) => {
          if (typeof error === "string") return { message: error };
          if (!error || typeof error !== "object") return { message: String(error) };
          return {
            orderId: error.orderId,
            field: error.field,
            code: error.code,
            message: error.message || error.error,
          };
        })
      : [];
  const safeOrders = (value) =>
    Array.isArray(value)
      ? value.map((order) => {
          if (typeof order === "string") return { orderId: order };
          if (!order || typeof order !== "object") return { orderId: String(order) };
          return {
            orderId: order.orderId,
            status: order.status,
            action: order.action,
            skipped: order.skipped,
            message: order.message,
          };
        })
      : [];

  const errors = safeErrors(source.errors);
  const errorsCount =
    source.errorsCount !== undefined ? numberOrZero(source.errorsCount) : errors.length;

  return {
    success:
      typeof source.success === "boolean" ? source.success : Boolean(fallbackSuccess),
    received: numberOrZero(source.received),
    inserted: numberOrZero(source.inserted),
    updated: numberOrZero(source.updated),
    skipped: numberOrZero(source.skipped),
    errorsCount,
    errors,
    orders: safeOrders(source.orders),
  };
};

const buildFulfillmentPlatformUrl = (baseUrl) =>
  `${String(baseUrl || "").replace(/\/+$/, "")}/api/portal/orders`;

const getBlockingProductionCases = (order) =>
  (Array.isArray(order?.case) ? order.case : [])
    .filter((caseDoc) => caseDoc && typeof caseDoc === "object" && caseDoc.blocksProduction === true)
    .map((caseDoc) => ({
      id: String(caseDoc._id || ""),
      name: caseDoc.name || "",
    }));

const hasProductionFile = (item) => {
  if (item?.svgFile) return true;
  return Object.keys(normalizeFulfillmentFile(item?.fulfillment_file)).length > 0;
};

const getProductionPrerequisiteErrors = (order) =>
  (Array.isArray(order?.items) ? order.items : []).flatMap((item) => {
    const errors = [];
    const itemId = item?.orderItemId || item?.transactionId || "";
    if (!hasProductionFile(item)) {
      errors.push({ itemId, code: "MISSING_FULFILLMENT_FILE", message: "Missing fulfillment file" });
    }
    return errors;
  });

// ====== GET QC LIST ======
const getQCList = async (req, res) => {
  try {
    const {
      page = 1,
      perPage = 10,
      from,
      to,
      scale_status, // filter theo scale_overall_status (order-level)
      search, // regex theo orderId (+ mở rộng sku/orderItemId/email/name/seller)
      shopName,
      sellerId,
    } = req.query;

    const userRole = req.user?.role;
    const userId = req.user?.userId || req.user?.id || req.user?._id || "";
    const isSeller = hasRole(userRole, "Seller");
    const isAdmin = hasRole(userRole, "Admin");
    const isDesignLeader = hasRole(userRole, "Design Leader");
    const isCS = hasRole(userRole, "Customer Service");
    const isSellerOnly = isSeller && !(isAdmin || isDesignLeader || isCS);

    const matchStage = {};
    if (from && to) {
      matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }
    if (isSellerOnly) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      matchStage.sellerId = new mongoose.Types.ObjectId(userId);
    }
    if (!isSellerOnly && sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
      matchStage.sellerId = new mongoose.Types.ObjectId(sellerId);
    }

    // ---- Scale status filter (đã đồng bộ khái niệm "All" = ACTIVE) ----
    let needFilterPendingItems = false;

    if (scale_status && String(scale_status).trim() !== "") {
      const raw = scale_status.trim();
      if (/^all$/i.test(raw)) {
        matchStage.scale_overall_status = { $in: ACTIVE };
      } else {
        const wanted = raw.split(",").map(canon).filter(Boolean);
        const valid = wanted.filter((v) => KNOWN.includes(v));
        if (valid.length > 0) {
          matchStage.scale_overall_status = { $in: valid };
          needFilterPendingItems = valid.length === 1 && valid[0] === "Pending";
        } else {
          // không khớp gì cả
          matchStage.scale_overall_status = { $in: ["__NO_MATCH__"] };
        }
      }
    } else {
      // không truyền => coi như All
      matchStage.scale_overall_status = { $in: ACTIVE };
      needFilterPendingItems = false;
    }

    // ---- Search OR ----
    let preLookupSearchOr = null;
    let postLookupSearchOr = null;
    if (search && search.trim() !== "") {
      const rawSearch = search.trim();
      if (isAmazonOrderId(rawSearch)) {
        matchStage.orderId = rawSearch;
      } else {
        const keyword = new RegExp(escapeRegExp(rawSearch), "i");
        preLookupSearchOr = [
          { orderId: keyword },
          { "items.sku": keyword },
          { "items.orderItemId": keyword },
          { "customer_infor.email": keyword },
          { "customer_infor.name": keyword },
        ];
        postLookupSearchOr = [
          { "seller.full_name": keyword },
          { "seller.email": keyword },
        ];
      }
    }

    // ---- Base pipeline (shop/seller lookup, case, search) ----
    const basePipeline = [
      { $match: matchStage },
      ...(preLookupSearchOr ? [{ $match: { $or: preLookupSearchOr } }] : []),
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
          localField: "sellerId",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
      ...(shopName && shopName.trim() !== ""
        ? [
            {
              $match: {
                "shop.name": { $regex: new RegExp(shopName.trim(), "i") },
              },
            },
          ]
        : []),
      ...(postLookupSearchOr ? [{ $match: { $or: postLookupSearchOr } }] : []),
    ];

    const pipeline = [...basePipeline];

    // Nếu tab Pending thì chỉ hiển thị item-level Pending thực sự
    if (needFilterPendingItems) {
      pipeline.push({
        $addFields: {
          items: {
            $filter: {
              input: "$items",
              as: "it",
              cond: { $eq: ["$$it.scale_status", "Pending"] },
            },
          },
        },
      });
      pipeline.push({ $match: { $expr: { $gt: [{ $size: "$items" }, 0] } } });
    }

    // ---- Count ----
    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await OrderCustomProduct.aggregate(countPipeline);
    const totalCount = countResult[0]?.total || 0;

    // ---- Pagination ----
    const isAll = String(perPage).toLowerCase() === "all";
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(perPage, 10);
    const skip = (pageNum - 1) * limitNum;

    pipeline.push({ $sort: { createdAt: -1 } });
    if (!isAll) pipeline.push({ $skip: skip }, { $limit: limitNum });
    pipeline.push(
      {
        $lookup: {
          from: "cases",
          localField: "case",
          foreignField: "_id",
          as: "case",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "scaleId",
          foreignField: "_id",
          as: "scaledBy",
        },
      },
      { $unwind: { path: "$scaledBy", preserveNullAndEmptyArrays: true } }
    );

    const orders = await OrderCustomProduct.aggregate(pipeline);

    // ---- Build vendor product display map ----
    const vendorIdSet = new Set();
    for (const o of orders) {
      for (const it of o.items || []) {
        const vId = it?.cost_breakdown?.vendorProductId;
        if (vId) vendorIdSet.add(String(vId));
      }
    }

    let vendorFullNameMap = new Map();
    if (vendorIdSet.size > 0) {
      const idObjs = Array.from(vendorIdSet)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      const vps = await VendorProduct.find({ _id: { $in: idObjs } })
        .select("product_name vendor_id")
        .populate({ path: "vendor_id", select: "name" })
        .lean();

      vendorFullNameMap = new Map(
        (vps || []).map((vp) => {
          const vendorName = vp?.vendor_id?.name || "";
          const productName = vp?.product_name || "";
          return [String(vp._id), `${vendorName} - ${productName}`.trim()];
        })
      );
    }

    // ---- Listing map (asin_type/product_image/psd) ----
    const listingIdSet = new Set();
    for (const o of orders) {
      for (const it of o.items || []) {
        const lid = it?.listingId;
        if (lid) listingIdSet.add(String(lid));
      }
    }

    let listingMap = new Map();
    if (listingIdSet.size > 0) {
      const ids = Array.from(listingIdSet)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      const listings = await Listing.find({ _id: { $in: ids } })
        .select("asin_type product_image psd")
        .lean();
      listingMap = new Map(listings.map((l) => [String(l._id), l]));
    }

    // ---- Shape response ----
    const result = orders.map((order) => {
      const items = (order.items || []).map((item) => {
        const surfaces = item.version3Data?.customizationInfo?.surfaces || [];
        const ldoc = item?.listingId
          ? listingMap.get(String(item.listingId))
          : null;
        const version3Data = surfaces.flatMap((surface) =>
          (surface.areas || []).map((area) => ({
            label: area.label || area.name || "",
            value: area.optionValue || area.text || "",
          }))
        );

        const vendorProductId = item?.cost_breakdown?.vendorProductId || null;
        const vendorProductDisplayName = vendorProductId
          ? vendorFullNameMap.get(String(vendorProductId)) || null
          : null;

        return {
          orderItemId: item.orderItemId || null,
          sku: item.sku,
          title: item.title || "",
          quantity: item.quantity || 1,
          version3Data,
          baseImageUrl: item.baseImage?.imageUrl || null,
          snapshotImage: item.snapshotImage,
          totalCustomizationPrice: item.totalCustomizationPrice || 0,
          asin: item.asin,
          customized_url: item.customized_url,
          cost_center: {
            vendorProductId,
            vendorProductDisplayName,
            sizeValue: item?.cost_breakdown?.sizeValue || null,
            colorValue: item?.cost_breakdown?.colorValue || null,
            vendorProductSKU: item?.cost_breakdown?.matchedSku,
          },
          tracking_info: {
            fulfillment: item?.tracking_info?.fulfillment,
            status: item?.tracking_info?.status,
            tracking: item?.tracking_info?.tracking,
            note: item?.tracking_info?.note,
          },
          fulfillment_file: item.fulfillment_file,
          scale_status: item.scale_status,
          qc_note: item.qc_note,
          cs_note: item?.tracking_info?.note || "",
          listingId: item.listingId,
          listing: ldoc
            ? {
                asin_type: ldoc.asin_type || null,
                product_image: ldoc.product_image || null,
                psd: ldoc.psd || null,
              }
            : null,
        };
      });

      return {
        orderId: order.orderId,
        merchantId: order.merchantId || null,
        marketplaceId: order.marketplaceId || null,
        customer_infor: order.customer_infor,
        status: order.status || "",
        customized_url: order.customized_url,
        purchase_date: order.purchase_date,
        createdAt: order.createdAt,
        shopName: order.shop?.name || null,
        shipping_type: order.shipping_type || null,
        items,
        base_cost: order.base_cost,
        case: order.case,
        address_validation: order.address_validation?.isValid,
        scale_overall_status: order.scale_overall_status,
        scaledBy: order.scaledBy
          ? {
              _id: order.scaledBy._id,
              full_name: order.scaledBy.full_name,
              email: order.scaledBy.email,
            }
          : null,
        seller: order.seller
          ? { email: order.seller.email, full_name: order.seller.full_name }
          : null,
      };
    });

    res.json({
      data: result,
      totalCount,
      totalPages: isAll ? 1 : Math.ceil(totalCount / limitNum),
      currentPage: pageNum,
    });
  } catch (error) {
    console.error("❌ getQCList error:", error);
    res.status(500).json({
      message: "Failed to retrieve QC list",
      error: error.message,
    });
  }
};

// ====== GET QC STATISTICS ======
const getQCStatistics = async (req, res) => {
  try {
    const {
      from,
      to,
      search,
      shopName,
      breakdown,
      timeseries = "false",
      sellerId,
    } = req.query;

    const userRole = req.user?.role;
    const userId = req.user?.userId || req.user?.id || req.user?._id || "";
    const isSeller = hasRole(userRole, "Seller");
    const isAdmin = hasRole(userRole, "Admin");
    const isDesignLeader = hasRole(userRole, "Design Leader");
    const isCS = hasRole(userRole, "Customer Service");
    const isSellerOnly = isSeller && !(isAdmin || isDesignLeader || isCS);

    const matchStage = {};
    if (from && to) {
      matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }
    if (isSellerOnly) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      matchStage.sellerId = new mongoose.Types.ObjectId(userId);
    }

    let searchOr = null;
    if (search && search.trim() !== "") {
      const keyword = new RegExp(search.trim(), "i");
      searchOr = [
        { orderId: keyword },
        { "items.sku": keyword },
        { "items.orderItemId": keyword },
        { "customer_infor.email": keyword },
        { "customer_infor.name": keyword },
      ];
    }

    const basePipeline = [
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
      ...(shopName && shopName.trim()
        ? [
            {
              $match: {
                "shop.name": { $regex: new RegExp(shopName.trim(), "i") },
              },
            },
          ]
        : []),
      ...(searchOr ? [{ $match: { $or: searchOr } }] : []),
      {
        $lookup: {
          from: "users",
          localField: "sellerId",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
      ...(!isSellerOnly && sellerId && mongoose.Types.ObjectId.isValid(sellerId)
        ? [{ $match: { "seller._id": new mongoose.Types.ObjectId(sellerId) } }]
        : []),
      {
        $addFields: {
          overall_status_bucket: {
            $let: {
              vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
              in: { $cond: [{ $in: ["$$s", KNOWN] }, "$$s", "Other"] },
            },
          },
        },
      },
    ];

    const overallPipeline = [
      ...basePipeline,
      { $group: { _id: "$overall_status_bucket", orders: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          byStatus: { $push: { k: "$_id", v: "$orders" } },
          totalOrders: { $sum: "$orders" }, // tổng theo toàn bộ bucket
        },
      },
      {
        $project: {
          _id: 0,
          totalOrders: 1,
          counts: { $arrayToObject: "$byStatus" },
        },
      },
    ];

    const normalizeCounts = (c = {}) => {
      const counts = {
        "Need Scale": c["Need Scale"] || 0,
        Pending: c["Pending"] || 0,
        Ready: c["Ready"] || 0,
        Sent: c["Sent"] || 0,
        Failed: c["Failed"] || 0,
        "QC Rejected": c["QC Rejected"] || 0,
        Cancelled: c["Cancelled"] || 0,
        "Address Invalid": c["Address Invalid"] || 0,
        Other: c["Other"] || 0,
      };
      // All = ACTIVE
      counts["All"] =
        counts["Pending"] +
        counts["Sent"] +
        counts["QC Rejected"] +
        counts["Ready"] +
        counts["Address Invalid"];
      return counts;
    };

    const [overallRaw] = await OrderCustomProduct.aggregate(overallPipeline);
    const counts = normalizeCounts(overallRaw?.counts);

    // ĐẢM BẢO FE hiển thị All khớp với list: totalOrders = ACTIVE
    const overall = {
      totalOrders: counts["All"],
      counts,
    };

    res.json({ overall });
  } catch (error) {
    console.error("❌ getQCStatistics error:", error);
    res.status(500).json({
      message: "Failed to retrieve QC statistics",
      error: error.message,
    });
  }
};

const updateQCNoteForItem = async (req, res) => {
  try {
    const { orderId, orderItemId } = req.params;
    let { qc_note } = req.body || {};

    qc_note = typeof qc_note === "string" ? qc_note.trim() : "";
    if (qc_note.length > 2000) {
      return res.status(400).json({ message: "qc_note vượt quá 2000 ký tự." });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const userRole = req.user?.role;
    const userId = req.user?.userId || req.user?.id || req.user?._id || "";
    const isSeller = hasRole(userRole, "Seller");
    const isAdmin = hasRole(userRole, "Admin");
    const isCS = hasRole(userRole, "Customer Service");
    const isSellerOnly = isSeller && !(isAdmin || isCS);

    if (isSellerOnly) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      if (String(order.sellerId || "") !== String(userId)) {
        return res.status(403).json({ message: "You can only QC your own orders" });
      }
    }

    const item = order.items.find((i) => i.orderItemId === orderItemId);
    if (!item) return res.status(404).json({ message: "Order item not found" });

    item.qc_note = qc_note;
    await order.save();
    await logOrderLifecycleEvent(buildOrderLifecyclePayload({
      order,
      req,
      fallbackPlatform: "amazon",
      stage: "QC",
      eventType: "QC_NOTE_UPDATED",
      status: "success",
      message: `QC note updated for item ${orderItemId}`,
      metadata: { orderItemId, note: qc_note },
    }));

    return res.json({
      message: "QC note updated.",
      orderId,
      orderItemId,
      qc_note: item.qc_note,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Update QC note failed", error: err.message });
  }
};

const sendFailedOrdersToFulfillment = async (req, res) => {
  const portalUrl = process.env.FULFILLMENT_PORTAL_URL;
  const portalApiKey = process.env.FULFILLMENT_PORTAL_API_KEY;
  const portalTimeoutMs = Number(process.env.FULFILLMENT_PORTAL_TIMEOUT_MS || 120000);

  if (!portalUrl || !portalApiKey) {
    return res.status(500).json({
      message: "Fulfillment portal configuration is missing",
    });
  }

  const rawOrderIds = req.body?.orderIds;
  if (!Array.isArray(rawOrderIds) || rawOrderIds.length === 0) {
    return res.status(400).json({
      message: "orderIds must be a non-empty array",
    });
  }

  const orderIds = [
    ...new Set(
      rawOrderIds
        .map((orderId) =>
          typeof orderId === "string" ? orderId.trim() : String(orderId || "").trim()
        )
        .filter(Boolean)
    ),
  ];

  if (orderIds.length === 0) {
    return res.status(400).json({
      message: "orderIds must contain at least one valid order id",
    });
  }

  try {
    const userRole = req.user?.role;
    const userId = req.user?.userId || req.user?.id || req.user?._id || "";
    const isSeller = hasRole(userRole, "Seller");
    const isAdmin = hasRole(userRole, "Admin");
    const isCS = hasRole(userRole, "Customer Service");
    const isSellerOnly = isSeller && !(isAdmin || isCS);

    const query = { orderId: { $in: orderIds } };
    if (isSellerOnly) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      query.sellerId = new mongoose.Types.ObjectId(userId);
    }

    const orders = await OrderCustomProduct.find(query)
      .populate({ path: "shopId", select: "name" })
      .populate({ path: "sellerId", select: "full_name email" })
      .populate({ path: "scaleId", select: "full_name email" })
      .populate({ path: "items.listingId", select: "asin_type product_image psd" });

    const foundOrderIds = new Set(orders.map((order) => order.orderId));
    const missingOrderIds = orderIds.filter((orderId) => !foundOrderIds.has(orderId));
    if (missingOrderIds.length > 0) {
      return res.status(404).json({
        message: "Some orders were not found or are not accessible",
        orderIds: missingOrderIds,
      });
    }

    const notFailedOrders = orders
      .filter((order) => order.scale_overall_status !== "Failed")
      .map((order) => ({
        orderId: order.orderId,
        scale_overall_status: order.scale_overall_status || null,
      }));
    if (notFailedOrders.length > 0) {
      return res.status(409).json({
        message: "Only orders with scale_overall_status Failed can be sent to fulfillment",
        orders: notFailedOrders,
      });
    }

    const payload = buildPortalPayload(orders);
    const payloadErrors = validatePortalPayload(payload);
    if (payloadErrors.length > 0) {
      return res.status(400).json({
        message: "Invalid fulfillment payload",
        errors: payloadErrors,
      });
    }

    let portalResponse;

    try {
      portalResponse = await axios.post(portalUrl, payload, {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": portalApiKey,
        },
        timeout: portalTimeoutMs,
      });
    } catch (error) {
      const portalError = getPortalError(error);

      await Promise.all(
        orders.map(async (order) => {
          const prevSubmission = order.fulfillment_portal_submission || {};
          order.fulfillment_portal_submission = {
            sent: false,
            sent_at: prevSubmission.sent_at || null,
            attempt_count: (prevSubmission.attempt_count || 0) + 1,
            last_response: {
              error: portalError.error,
              at: new Date(),
            },
          };
          await order.save();
        })
      );

      return res.status(portalError.status).json({
        message: "Failed to send orders to fulfillment",
        error: portalError.error,
      });
    }

    const responseData = portalResponse?.data || null;
    await Promise.all(
      orders.map(async (order) => {
        const prevOverallStatus = order.scale_overall_status;
        const prevOrderStatus = order.status;
        const prevSubmission = order.fulfillment_portal_submission || {};
        const fulfilledAt = new Date();
        order.fulfillment_portal_submission = {
          sent: true,
          sent_at: fulfilledAt,
          attempt_count: (prevSubmission.attempt_count || 0) + 1,
          last_response: responseData,
        };
        order.scale_overall_status = "Sent";
        order.status = "Fulfilled";

        for (const item of order.items || []) {
          item.tracking_info = item.tracking_info || {};
          if (
            item.tracking_info.status !== "Shipped" &&
            !isCanceledStatus(item.tracking_info.status)
          ) {
            item.tracking_info.status = "Fulfilled";
          }
          item.tracking_info.updated_at = fulfilledAt;
        }

        await order.save();

        await logOrderHistory({
          orderDoc: order,
          action: "SEND_TO_FULFILLMENT_PORTAL",
          description: "Order sent to fulfillment portal.",
          changes: [
            {
              field: "scale_overall_status",
              from: prevOverallStatus,
              to: "Sent",
            },
            {
              field: "status",
              from: prevOrderStatus,
              to: "Fulfilled",
            },
            {
              field: "fulfillment_portal_submission.sent",
              from: !!prevSubmission.sent,
              to: true,
            },
          ],
          user: req.user,
          context: {
            source: "SYSTEM",
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          },
        });
      })
    );

    return res.json({
      message: "Sent orders to fulfillment successfully",
      sentCount: orders.length,
      data: responseData,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to send orders to fulfillment",
      error: err.message,
    });
  }
};

const recordFulfillmentPlatformV2Failure = async (orders, fulfillment, sourceChannel = "AMAZON", req = null) => {
  await Promise.all(
    (orders || []).map(async (order) => {
      const prevSubmission = order.fulfillment_platform_v2_submission || {};
      const attemptCount = (prevSubmission.attempt_count || 0) + 1;
      order.fulfillment_platform_v2_submission = {
        sent: false,
        sent_at: prevSubmission.sent_at || null,
        attempt_count: attemptCount,
        last_response: fulfillment,
        sourceChannel,
      };
      await order.save();
      await logOrderLifecycleEvent(buildOrderLifecyclePayload({
        order,
        req,
        fallbackPlatform: "amazon",
        stage: "VENDOR_PUSH",
        eventType: "VENDOR_PUSH_FAILED",
        status: "failed",
        reason: "Failed to push orders to Fulfillment Platform",
        metadata: {
          provider: "fulfillment-platform-v2",
          attemptCount,
          sourceChannel,
        },
      }));
    })
  );
};

const recordFulfillmentPlatformV2Success = async ({
  orders,
  fulfillment,
  req,
  sourceChannel = "AMAZON",
}) => {
  const fulfilledAt = new Date();

  await Promise.all(
    (orders || []).map(async (order) => {
      const prevOverallStatus = order.scale_overall_status;
      const prevOrderStatus = order.status;
      const prevSubmission = order.fulfillment_platform_v2_submission || {};
      const attemptCount = (prevSubmission.attempt_count || 0) + 1;

      order.fulfillment_platform_v2_submission = {
        sent: true,
        sent_at: fulfilledAt,
        attempt_count: attemptCount,
        last_response: fulfillment,
        sourceChannel,
      };
      order.scale_overall_status = "Sent";
      order.status = "Fulfilled";

      for (const item of order.items || []) {
        item.tracking_info = item.tracking_info || {};
        if (
          item.tracking_info.status !== "Shipped" &&
          !isCanceledStatus(item.tracking_info.status)
        ) {
          item.tracking_info.status = "Fulfilled";
        }
        item.tracking_info.updated_at = fulfilledAt;
      }

      await order.save();

      await logOrderHistory({
        orderDoc: order,
        action: "PUSH_TO_FULFILLMENT_PLATFORM_V2",
        description: "Order pushed to Fulfillment Platform v2.",
        changes: [
          {
            field: "scale_overall_status",
            from: prevOverallStatus,
            to: "Sent",
          },
          {
            field: "status",
            from: prevOrderStatus,
            to: "Fulfilled",
          },
          {
            field: "fulfillment_platform_v2_submission.sent",
            from: !!prevSubmission.sent,
            to: true,
          },
        ],
        user: req.user,
        context: {
          source: "SYSTEM",
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
      });
      await logOrderLifecycleEvent(buildOrderLifecyclePayload({
        order,
        req,
        fallbackPlatform: "amazon",
        stage: "VENDOR_PUSH",
        eventType: "VENDOR_PUSH_SUCCESS",
        status: "success",
        message: "Order pushed to Fulfillment Platform v2.",
        metadata: {
          provider: "fulfillment-platform-v2",
          attemptCount,
          alreadySent: false,
          sourceChannel,
        },
      }));
    })
  );
};

const pushPlatformOrders = async (req, res) => {
  const apiBaseUrl = String(process.env.FULFILLMENT_API_BASE_URL || "").trim();
  const tenantApiKey = String(process.env.FULFILLMENT_TENANT_API_KEY || "").trim();
  const timeoutMs = Number(process.env.FULFILLMENT_API_TIMEOUT_MS || 30000);
  let orders = [];

  if (!apiBaseUrl || !tenantApiKey) {
    return res.status(500).json({
      message: "Fulfillment Platform configuration is missing",
    });
  }

  const orderIds = normalizeOrderIds(req.body?.orderIds);
  if (!orderIds) {
    return res.status(400).json({
      message: "orderIds must be a non-empty array",
    });
  }

  if (orderIds.length === 0) {
    return res.status(400).json({
      message: "orderIds must contain at least one valid order id",
    });
  }

  try {
    const userRole = req.user?.role;
    const userId = req.user?.userId || req.user?.id || req.user?._id || "";
    const isSeller = hasRole(userRole, "Seller");
    const isAdmin = hasRole(userRole, "Admin");
    const isCS = hasRole(userRole, "Customer Service");
    const isSellerOnly = isSeller && !(isAdmin || isCS);

    const query = { orderId: { $in: orderIds } };
    if (isSellerOnly) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      query.sellerId = new mongoose.Types.ObjectId(userId);
    }

    orders = await OrderCustomProduct.find(query)
      .populate({ path: "shopId", select: "name" })
      .populate({ path: "sellerId", select: "full_name email" })
      .populate({ path: "scaleId", select: "full_name email" })
      .populate({ path: "case", select: "name blocksProduction" })
      .populate({ path: "items.listingId", select: "asin_type product_image psd" });

    const foundOrderIds = new Set(orders.map((order) => order.orderId));
    const missingOrderIds = orderIds.filter((orderId) => !foundOrderIds.has(orderId));
    if (missingOrderIds.length > 0) {
      return res.status(404).json({
        message: "Some orders were not found or are not accessible",
        orderIds: missingOrderIds,
      });
    }

    const notPushableOrders = orders
      .filter((order) => !["Ready", "Failed"].includes(order.scale_overall_status))
      .map((order) => ({
        orderId: order.orderId,
        scale_overall_status: order.scale_overall_status || null,
      }));
    if (notPushableOrders.length > 0) {
      return res.status(409).json({
        message: "Only orders with scale_overall_status Ready or Failed can be pushed to Fulfillment Platform v2",
        orders: notPushableOrders,
      });
    }

    const blockedOrders = orders
      .map((order) => ({
        orderId: order.orderId,
        cases: getBlockingProductionCases(order),
      }))
      .filter((entry) => entry.cases.length > 0);
    if (blockedOrders.length > 0) {
      return res.status(409).json({
        message: "Some orders have blocking case(s) and cannot be pushed to production",
        orders: blockedOrders,
      });
    }

    const invalidProductionOrders = orders
      .map((order) => ({
        orderId: order.orderId,
        errors: getProductionPrerequisiteErrors(order),
      }))
      .filter((entry) => entry.errors.length > 0);
    if (invalidProductionOrders.length > 0) {
      return res.status(409).json({
        message: "Some orders are missing production prerequisites",
        orders: invalidProductionOrders,
      });
    }

    const payload = buildPortalPayload(orders);
    payload.data = payload.data.map((order) => ({
      ...order,
      source: "portal",
      sourceChannel: "AMAZON",
    }));
    const payloadErrors = validatePortalPayload(payload);
    if (payloadErrors.length > 0) {
      return res.status(400).json({
        message: "Invalid Fulfillment Platform v2 payload",
        errors: payloadErrors,
      });
    }

    console.info(
      "[QC][pushPlatformOrders] payload preview",
      buildFulfillmentPlatformPayloadPreview(payload)
    );

    const platformResponse = await axios.post(
      buildFulfillmentPlatformUrl(apiBaseUrl),
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tenantApiKey}`,
        },
        timeout: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
      }
    );

    const fulfillment = toSafeFulfillmentSummary(platformResponse?.data, true);
    await recordFulfillmentPlatformV2Success({
      orders,
      fulfillment,
      req,
      sourceChannel: "AMAZON",
    });

    return res.json({
      message: "Pushed orders to Fulfillment Platform v2",
      attemptedCount: orders.length,
      sentCount: orders.length,
      fulfillment,
    });
  } catch (err) {
    if (err.response) {
      const fulfillment = toSafeFulfillmentSummary(err.response.data, false);
      console.error("[QC][pushPlatformOrders] Fulfillment Platform error", {
        status: err.response.status,
        data: err.response.data,
        payloadPreview: buildFulfillmentPlatformPayloadPreview(parseAxiosRequestPayload(err.config?.data)),
      });
      await recordFulfillmentPlatformV2Failure(orders, fulfillment, "AMAZON", req);

      return res.status(err.response.status || 502).json({
        message: "Failed to push orders to Fulfillment Platform",
        attemptedCount: orderIds.length,
        fulfillment,
        platformStatus: err.response.status,
      });
    }

    const fulfillment = toSafeFulfillmentSummary(
      {
        success: false,
        errorsCount: 1,
        errors: [{ message: err.message || "Fulfillment Platform request failed" }],
      },
      false
    );
    await recordFulfillmentPlatformV2Failure(orders, fulfillment, "AMAZON", req);

    return res.status(502).json({
      message: "Failed to push orders to Fulfillment Platform",
      attemptedCount: orderIds.length,
      fulfillment,
    });
  }
};

module.exports = {
  getQCList,
  getQCStatistics,
  updateQCNoteForItem,
  sendFailedOrdersToFulfillment,
  pushPlatformOrders,
};
