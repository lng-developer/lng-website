const mongoose = require('mongoose');
<<<<<<< Updated upstream:src/helper/orderHelper.js
const db = require("../models");
const OrderCustomProduct = db.orderCustomProduct;
const VendorProduct = db.vendorProduct;
const Vendor = db.vendor;
const Listing = db.listing;
const Team = db.Team;
const User = db.user;
=======
const OrderCustomProduct = require("../models/order.model");
const VendorProduct = require("../../vendor/models/vendorProduct.model");
const Vendor = require("../../vendor/models/vendor.model");
const Listing = require("../../catalog/models/listing.model");
const Team = require("../../team/models/team.model");
const User = require("../../auth/models/user.model");
>>>>>>> Stashed changes:src/modules/order/helpers/orderHelper.js

function validateIds({ teamId, sellerId, userId }) {
  const result = {
    teamObjectId: null,
    sellerObjectId: null,
    error: null
  };

  if (teamId) {
    if (!mongoose.isValidObjectId(teamId)) {
      result.error = "Invalid team id";
      return result;
    }
    result.teamObjectId = mongoose.Types.ObjectId.createFromHexString(teamId);
  }

  if (sellerId) {
    if (!mongoose.isValidObjectId(sellerId)) {
      result.error = "Invalid seller id";
      return result;
    }
    result.sellerObjectId = mongoose.Types.ObjectId.createFromHexString(sellerId);
  }

  if (userId && !mongoose.isValidObjectId(userId)) {
    result.error = "Invalid user id in token";
    return result;
  }
  return result;
}

function buildInitialMatch(ids, roles, userId, userNull) {
  const match = {};

  // Filter by sellerId FIRST (use index)
  if (ids.sellerObjectId) {
    match.sellerId = ids.sellerObjectId;
  } else if (roles.isSeller && !roles.isProduction) {
    // Seller only sees own orders
    match.sellerId = mongoose.Types.ObjectId.createFromHexString(userId);
  } else if (roles.isAdmin && userNull === "true") {
    // Admin filtering null users
    match.sellerId = { $in: [null, undefined] };
  }

  return match;
}

function normalizeBool(v) {
  return String(v).toLowerCase() === "true";
}

async function getListingIdsNoPsd(ListingModel) {
  // lấy listing có psd.status = Unavailable (tolerant spaces + case-insensitive)
  const docs = await ListingModel.find(
    { "psd.status": { $regex: /^\s*unavailable\s*$/i } },
    { _id: 1 }
  ).lean();

  return docs.map((d) => d._id);
}


function buildFilters(params) {
  const {
    statuses,
    search,
    openCase,
    from,
    to,
    isNoCostCenter,
    financialStatus,
    sevenDayAlert,
    platform,
    noPsd,
    shippingType
  } = params;

  const filters = [];

  if (statuses?.trim()) {
    const statusArray = statuses.split(",").map(s => s.trim()).filter(Boolean);
    if (statusArray.length > 0) {
      filters.push({ status: { $in: statusArray } });
    }
  }

  if (search) {
    const keyword = new RegExp(search, "i");
    filters.push({
      $or: [
        { orderId: keyword },
        { "customer_infor.name": keyword },
        { "items.sku": keyword },
        { "items.asin": keyword }
      ]
    });
  }

  if (openCase === "true") {
    filters.push({ case: { $exists: true, $not: { $size: 0 } } });
  }

  if (from && to) {
    if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) 
        {
            return res.status(400).json({ message: "Invalid date format in from or to" });
        }
    filters.push({
        purchase_date: { 
            $gte: new Date(from), 
            $lte: new Date(to) 
        }
    });
   }

  if (isNoCostCenter === "true") {
    filters.push({ base_cost: { $in: [null, 0] } });
  }

  if (financialStatus) {
    filters.push({ financialStatus });
  }

  if (sevenDayAlert === "true") {
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    filters.push({ deliveryDate: { $lte: sevenDaysLater } });
  }

  if (platform) {
    filters.push({ platform });
  }

  if (noPsd === "true") {
    filters.push({ "items.snapshotImage": { $in: [null, ""] } });
  }

  if (shippingType?.trim()) {
    const validTypes = ["Second Day", "Ground", "Overnight", "Economy", "Standard", "Expedited"];
    const types = shippingType.split(",").map(t => t.trim()).filter(t => validTypes.includes(t));
    if (types.length > 0) {
      filters.push({ shipping_type: types.length === 1 ? types[0] : { $in: types } });
    }
  }

  return filters;
}

async function buildVendorFilter() {
  const vpIds = await getVendorProductIdsByVendorName("LNG Group");
  
  if (!vpIds || vpIds.length === 0) {
    return null;
  }

  const vpIdsStr = vpIds.map(id => String(id));
  const vpIdsObj = vpIdsStr
    .filter(s => mongoose.Types.ObjectId.isValid(s))
    .map(s => mongoose.Types.ObjectId.createFromHexString(s));

  return {
    $or: [
      { "items.cost_breakdown.vendorProductId": { $in: vpIdsStr } },
      { "items.cost_breakdown.vendorProductId": { $in: vpIdsObj } }
    ]
  };
}

async function getVendorProductIdsByVendorName(vendorName) {
  const vdoc = await Vendor.findOne(
    { name: new RegExp(`^${vendorName}$`, "i") },
    { _id: 1 }
  ).lean();
  if (!vdoc?._id) return [];
  const vpIds = await VendorProduct.distinct("_id", { vendor_id: vdoc._id });
  return vpIds || [];
}

async function buildPipeline({ initialMatch, filters, userId, teamObjectId, shopName }) {
  const pipeline = [];

  const team = await Team.findOne({ leaderId: userId }).select("_id").lean();
  const adjustedInitialMatch = { ...initialMatch };
  if (team && adjustedInitialMatch.sellerId) {
    delete adjustedInitialMatch.sellerId;
  }

  if (Object.keys(adjustedInitialMatch).length > 0) {
    pipeline.push({ $match: adjustedInitialMatch });
  }

  pipeline.push(
    {
      $lookup: {
        from: "shops",
        localField: "shopId",
        foreignField: "_id",
        as: "shop"
      }
    },
    { $unwind: { path: "$shop", preserveNullAndEmptyArrays: true } }
  );

  if (shopName?.trim()) {
    pipeline.push({
      $match: {
        "shop.name": { $regex: new RegExp(shopName.trim(), "i") }
      }
    });
  }
  if (teamObjectId || team) {
    const teamId = teamObjectId || team._id;
    const teamUserIds = await User.find({ team_id: teamId })
      .select("_id")
      .lean();
    const userIds = teamUserIds.map((u) => u._id);
    pipeline.push({
      $match: {
        sellerId: { $in: userIds },
      },
    });
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "sellerId",
        foreignField: "_id",
        as: "seller",
      },
    });
  } else {
    pipeline.push({
      $lookup: {
        from: "users",
        localField: "sellerId",
        foreignField: "_id",
        as: "seller",
      },
    });
  }

  pipeline.push({
    $unwind: { path: "$seller", preserveNullAndEmptyArrays: true }
  });

  pipeline.push({
    $lookup: {
      from: "users",
        localField: "scaleId",
        foreignField: "_id",
        as: "scaledBy",
    }
  });

  pipeline.push({
    $unwind: { path: "$scaledBy", preserveNullAndEmptyArrays: true }
  });

  pipeline.push({
    $lookup: {
      from: "cases",
      localField: "case",
      foreignField: "_id",
      as: "case"
    }
  });

  if (filters.length > 0) {
    pipeline.push({ $match: { $and: filters } });
  }

  if (teamObjectId) {
    pipeline.push({ $match: { "seller": { $ne: null } } });
  }

  return pipeline;
}

async function executePipeline(pipeline, page, perPage) {
  const countPipeline = [...pipeline, { $count: "total" }];
  const countResult = await OrderCustomProduct.aggregate(countPipeline);
  const totalCount = countResult[0]?.total || 0;

  const isAll = String(perPage).toLowerCase() === "all";
  const pageNum = parseInt(page) || 1;
  const limitNum = isAll ? totalCount || 1 : parseInt(perPage) || 10;
  const skip = isAll ? 0 : (pageNum - 1) * limitNum;

  pipeline.push({ $sort: { purchase_date: -1 } });
  if (!isAll) {
    pipeline.push({ $skip: skip }, { $limit: limitNum });
  }

  const orders = await OrderCustomProduct.aggregate(pipeline);

  console.log(totalCount)
  console.log(limitNum)
  return { orders, totalCount, limitNum };
}

async function enrichOrdersData(orders) {
  const listingIds = new Set();
  const vendorIds = new Set();

  orders.forEach(order => {
    (order.items || []).forEach(item => {
      if (item.listingId) listingIds.add(String(item.listingId));
      if (item.cost_breakdown?.vendorProductId) {
        vendorIds.add(String(item.cost_breakdown.vendorProductId));
      }
    });
  });

  const listingMap = await fetchListings(listingIds);
  
  const vendorMap = await fetchVendorProducts(vendorIds);

  return orders.map(order => enrichOrder(order, listingMap, vendorMap));
}

async function fetchListings(listingIds) {
  if (listingIds.size === 0) return new Map();

  const validIds = [...listingIds]
    .filter(id => mongoose.Types.ObjectId.isValid(id))
    .map(id => mongoose.Types.ObjectId.createFromHexString(id));

  if (validIds.length === 0) return new Map();

  const listings = await Listing.find({ _id: { $in: validIds } })
    .select("asin_type product_image psd")
    .lean();

  return new Map(listings.map(l => [String(l._id), l]));
}

async function fetchVendorProducts(vendorIds) {
  if (vendorIds.size === 0) return new Map();

  const validIds = [...vendorIds]
    .filter(id => mongoose.Types.ObjectId.isValid(id))
    .map(id => mongoose.Types.ObjectId.createFromHexString(id));

  if (validIds.length === 0) return new Map();

  const vps = await VendorProduct.find({ _id: { $in: validIds } })
    .select("product_name vendor_id")
    .populate({ path: "vendor_id", select: "name" })
    .lean();

  return new Map(
    vps.map(vp => {
      const vendorName = vp.vendor_id?.name || "";
      const productName = vp.product_name || "";
      const fullName = `${vendorName} - ${productName}`.trim();
      return [String(vp._id), fullName];
    })
  );
}

function enrichOrder(order, listingMap, vendorMap) {
  const items = (order.items || []).map(item => {
    const ffRaw = item.fulfillment_file || item.fulfilment_file || {};
    const fileUrls = extractFileUrls(ffRaw);
    
    const vendorProductId = item.cost_breakdown?.vendorProductId;
    const listing = item.listingId ? listingMap.get(String(item.listingId)) : null;

    return {
      orderItemId: item.orderItemId || null,
      sku: item.sku,
      mapped_sku: item.mapped_sku,
      title: item.title || "",
      quantity: item.quantity || 1,
      version3Data: extractVersion3Data(item),
      baseImageUrl: item.baseImage?.imageUrl || null,
      snapshotImage: item.snapshotImage,
      totalCustomizationPrice: item.totalCustomizationPrice || 0,
      asin: item.asin,
      customized_url: item.customized_url,
      download_url: fileUrls[0] || null,
      download_links: fileUrls,
      listingId: item.listingId || null,
      listing: listing ? {
        asin_type: listing.asin_type || null,
        product_image: listing.product_image || null,
        psd: listing.psd || null
      } : null,
      cost_center: {
        vendorProductId,
        vendorProductDisplayName: vendorProductId ? vendorMap.get(String(vendorProductId)) || null : null,
        sizeValue: item.cost_breakdown?.sizeValue || null,
        colorValue: item.cost_breakdown?.colorValue || null
      },
      tracking_info: {
        fulfillment: item.tracking_info?.fulfillment,
        status: item.tracking_info?.status,
        tracking: item.tracking_info?.tracking,
        note: item.tracking_info?.note
      },
      fulfillment_file: item.fulfillment_file,
      scale_status: item.scale_status,
      qc_note: item.qc_note
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
    seller: order.seller ? {
      _id: order.seller._id,
      full_name: order.seller.full_name,
      email: order.seller.email
    } : null,
    scaledBy: order.scaledBy ? {
      _id: order.scaledBy._id,
      full_name: order.scaledBy.full_name,
      email: order.scaledBy.email
    } : null,
    amazon_finance_total: order.amazon_finance_total,
    amazon_total_quantity: order.amazon_total_quantity
  };
}

function extractVersion3Data(item) {
    const surfaces = item.version3Data?.customizationInfo?.surfaces || [];
    return surfaces.flatMap((surface) =>
      (surface.areas || []).map((area) => ({
        label: area.label || area.name || "",
        value: area.optionValue || area.text || area.numberValue || "",
      }))
    );
}

function extractFileUrls(ffRaw) {
  if (!ffRaw || typeof ffRaw !== "object") return [];

  const urls = [];
  for (const v of Object.values(ffRaw)) {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) {
      urls.push(v);
    } else if (v && typeof v === "object" && typeof v.url === "string" && /^https?:\/\//i.test(v.url)) {
      urls.push(v.url);
    }
  }
  return urls;
}

module.exports = {
    validateIds,
    buildInitialMatch,
    buildFilters,
    buildVendorFilter,
    buildPipeline,
    executePipeline,
    enrichOrdersData,
    getVendorProductIdsByVendorName,
    getListingIdsNoPsd,
    normalizeBool
}