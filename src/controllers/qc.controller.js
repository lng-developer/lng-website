// controllers/qc.controller.js
const mongoose = require("mongoose");
const db = require("../models");
const OrderCustomProduct = db.orderCustomProduct;
const VendorProduct = db.vendorProduct;
const Listing = db.listing;

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

    const canon = (s) => {
      const t = String(s || "").trim();
      if (!t) return "";
      if (/^complete$/i.test(t)) return "Ready";
      if (/^qc\s*reject(?:ed)?$/i.test(t)) return "QC Rejected";
      if (/^addr(?:ess)?\s*invalid$/i.test(t)) return "Address Invalid";
      return t;
    };

    const matchStage = {};

    if (from && to) {
      matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    let needFilterPendingItems = false;

    if (scale_status && String(scale_status).trim() !== "") {
      if (/^all$/i.test(scale_status.trim())) {
        matchStage.scale_overall_status = {
          $in: ["Pending", "Sent", "QC Rejected", "Ready", "Address Invalid"],
        };
      } else {
        const wanted = scale_status.split(",").map(canon).filter(Boolean);
        const valid = wanted.filter((v) => KNOWN.includes(v));
        if (valid.length > 0) {
          matchStage.scale_overall_status = { $in: valid };
          needFilterPendingItems = valid.length === 1 && valid[0] === "Pending";
        } else {
          matchStage.scale_overall_status = { $in: ["__NO_MATCH__"] };
        }
      }
    } else {
      matchStage.scale_overall_status = {
        $in: [
          "Pending",
          "Sent",
          "QC Rejected",
          "Ready",
          "Failed",
          "Cancelled",
          "Address Invalid",
        ],
      };
      needFilterPendingItems = false;
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
        { "seller.full_name": keyword },
        { "seller.email": keyword },
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
      {
        $lookup: {
          from: "cases",
          localField: "case",
          foreignField: "_id",
          as: "case",
        },
      },
      ...(searchOr ? [{ $match: { $or: searchOr } }] : []),
    ];

    if (sellerId && mongoose.Types.ObjectId.isValid(sellerId)) {
      basePipeline.push({
        $match: { "seller._id": new mongoose.Types.ObjectId(sellerId) },
      });
    }

    const pipeline = [...basePipeline];

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

    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await OrderCustomProduct.aggregate(countPipeline);
    const totalCount = countResult[0]?.total || 0;

    const isAll = String(perPage).toLowerCase() === "all";
    const skip = (parseInt(page, 10) - 1) * parseInt(perPage, 10);
    const limit = parseInt(perPage, 10);

    pipeline.push({ $sort: { createdAt: -1 } });
    if (!isAll) pipeline.push({ $skip: skip }, { $limit: limit });

    const orders = await OrderCustomProduct.aggregate(pipeline);

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
          tracking_info: item.tracking_info || {},
          fulfillment_file: item.fulfillment_file,
          scale_status: item.scale_status,
          qc_note: item.qc_note,
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
        customer_infor: order.customer_infor,
        shopName: order.shop?.name || null,
        scale_overall_status: order.scale_overall_status,
        seller: order.seller
          ? {
            _id: order.seller._id,
            full_name: order.seller.full_name,
            email: order.seller.email,
          }
          : null,
        items,
      };
    });

    res.json({
      data: result,
      totalCount,
      totalPages: isAll ? 1 : Math.ceil(totalCount / limit),
      currentPage: parseInt(page, 10),
    });
  } catch (error) {
    console.error("❌ getQCList error:", error);
    res.status(500).json({
      message: "Failed to retrieve QC list",
      error: error.message,
    });
  }
};

// ---------------- STATISTICS ----------------
const getQCStatistics = async (req, res) => {
  try {
    const { from, to, search, shopName, breakdown, timeseries = "false", sellerId } =
      req.query;

    const matchStage = {};
    if (from && to) {
      matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
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
      ...(sellerId && mongoose.Types.ObjectId.isValid(sellerId)
        ? [{ $match: { "seller._id": new mongoose.Types.ObjectId(sellerId) } }]
        : []),
      {
        $addFields: {
          overall_status_bucket: {
            $let: {
              vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
              in: {
                $cond: [{ $in: ["$$s", KNOWN] }, "$$s", "Other"],
              },
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
          totalOrders: { $sum: "$orders" },
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
      counts["All"] =
        counts["Pending"] +
        counts["Sent"] +
        counts["QC Rejected"] +
        counts["Ready"] +
        counts["Address Invalid"];
      return counts;
    };

    const [overallRaw] = await OrderCustomProduct.aggregate(overallPipeline);

    const overall = {
      totalOrders: overallRaw?.totalOrders || 0,
      counts: normalizeCounts(overallRaw?.counts),
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

    const item = order.items.find((i) => i.orderItemId === orderItemId);
    if (!item) return res.status(404).json({ message: "Order item not found" });

    item.qc_note = qc_note;
    await order.save();

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
module.exports = { getQCList, getQCStatistics, updateQCNoteForItem };
