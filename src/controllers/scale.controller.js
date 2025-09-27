// controllers/orderFulfillment.controller.js
const multer = require("multer");
const mongoose = require("mongoose");
const db = require("../models");
const cloudinary = require("../utils/cloudinary");
const FulfillmentService = require("../service/fulfillment"); // <<< NEW
const OrderCustomProduct = db.orderCustomProduct;
const VendorProduct = db.vendorProduct;
const Listing = db.listing;
const upload = multer({ storage: multer.memoryStorage() });

// ============ Helpers (giữ nguyên) ============
function uploadStreamToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "image", overwrite: true, ...opts },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

function computeOverallScaleStatus(orderDoc) {
  const items = orderDoc.items || [];
  if (items.length === 0) return "Need Scale";
  const statuses = items.map((i) => i.scale_status || "Need Scale");
  const allComplete = statuses.every((s) => s === "Complete");
  const anyPendingOrComplete = statuses.some(
    (s) => s === "Pending" || s === "Complete"
  );
  const anyRejected = statuses.some((s) => s === "QC Rejected");
  if (anyRejected) return "QC Rejected";
  if (allComplete) return "Ready";
  if (anyPendingOrComplete) return "Pending";
  return "Need Scale";
}

// ============ Controllers ============

const uploadFulfillmentFileForItem = [
  upload.array("files"),
  async (req, res) => {
    try {
      const { orderId, orderItemId } = req.params;
      const { meta } = req.body;

      if (!req.files?.length)
        return res.status(400).json({ message: "Missing files" });

      let positions = [];
      try {
        positions = JSON.parse(meta);
      } catch {
        return res.status(400).json({ message: "Invalid meta JSON" });
      }

      if (positions.length !== req.files.length) {
        return res
          .status(400)
          .json({ message: "Files count not match positions" });
      }

      const order = await OrderCustomProduct.findOne({ orderId });
      if (!order) return res.status(404).json({ message: "Order not found" });

      const item = order.items.find((i) => i.orderItemId === orderItemId);
      if (!item)
        return res.status(404).json({ message: "Order item not found" });

      const ff = item.fulfillment_file;
      if (!ff) item.fulfillment_file = new Map();
      else if (typeof ff === "string") item.fulfillment_file = new Map();
      else if (!(ff instanceof Map))
        item.fulfillment_file = new Map(Object.entries(ff));

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const pos = String(positions[i]?.position || "")
          .trim()
          .toLowerCase();
        if (!pos)
          return res
            .status(400)
            .json({ message: `Missing position for file index ${i}` });

        const public_id = `fulfillment_files/${orderId}-${orderItemId}-${pos}`;
        const up = await uploadStreamToCloudinary(file.buffer, { public_id });
        item.fulfillment_file.set(pos, up.secure_url);
      }

      item.scale_status = "Pending";
      order.scale_overall_status = computeOverallScaleStatus(order);
      item.markModified("fulfillment_file");
      await order.save();

      return res.json({
        message: "Uploaded fulfillment files successfully",
        fulfillment_file: Object.fromEntries(item.fulfillment_file),
        item_scale_status: item.scale_status,
        order_scale_overall_status: order.scale_overall_status,
      });
    } catch (err) {
      return res
        .status(500)
        .json({ message: "Upload failed", error: err.message });
    }
  },
];

// Chuẩn hóa provider từ Vendor.fulfillment_type hoặc Vendor.name
function normalizeProviderKey(vendorDoc) {
  const ft = String(vendorDoc?.fulfillment_type || "").toLowerCase();
  const nm = String(vendorDoc?.name || "").toLowerCase();

  if (ft.includes("merchfox") || nm.includes("merchfox")) return "merchfox";
  if (ft.includes("grabink") || nm.includes("grabink")) return "grabink";
  if (ft.includes("merchize") || nm.includes("merchize")) return "merchize";

  // có thể bổ sung thêm provider khác ở đây
  return null;
}

/**
 * Suy ra provider từ order.items[].cost_breakdown.vendorProductId
 * - Trả về { providerKey, reasons[] }
 * - Nếu không tìm thấy: providerKey = null
 * - Nếu nhiều provider khác nhau: ném lỗi có status=409
 */
async function resolveProviderFromOrder(orderDoc, VendorProductModel) {
  const idObjs = [];

  for (const it of orderDoc.items || []) {
    const raw = it?.cost_breakdown?.vendorProductId;
    if (!raw) continue;

    // Nếu đã là ObjectId thì dùng luôn, nếu là string thì validate + new
    if (
      typeof raw === "object" &&
      raw !== null &&
      raw._bsontype === "ObjectID"
    ) {
      idObjs.push(raw);
      continue;
    }

    const s = String(raw);
    if (mongoose.isValidObjectId(s)) {
      idObjs.push(new mongoose.Types.ObjectId(s)); // <-- luôn dùng new
    }
  }

  if (idObjs.length === 0) {
    return {
      providerKey: null,
      reasons: ["No valid vendorProductId found on items"],
    };
  }

  // Lấy VendorProduct + populate vendor_id
  const vps = await VendorProductModel.find({ _id: { $in: idObjs } })
    .select("vendor_id")
    .populate({ path: "vendor_id", select: "name fulfillment_type status" })
    .lean();

  if (!vps?.length) {
    return { providerKey: null, reasons: ["No VendorProduct matched in DB"] };
  }

  // Gom provider
  const provSet = new Set();
  for (const vp of vps) {
    const key = normalizeProviderKey(vp?.vendor_id);
    if (key) provSet.add(key);
  }

  if (provSet.size > 1) {
    const many = [...provSet];
    const err = new Error(
      `Multiple providers detected in order: ${many.join(", ")}`
    );
    err.status = 409;
    err.code = "MULTIPLE_VENDORS_IN_ORDER";
    err.providers = many;
    throw err;
  }

  if (provSet.size === 0) {
    return {
      providerKey: null,
      reasons: ["Vendor present but cannot map to a provider"],
    };
  }

  return { providerKey: [...provSet][0], reasons: [] };
}

const confirmScaleForItem = async (req, res) => {
  try {
    const { orderId, orderItemId } = req.params;
    const { decision, note, provider } = req.body || {}; // provider optional

    const d = String(decision || "").toLowerCase();
    if (!["approve", "reject"].includes(d)) {
      return res
        .status(400)
        .json({ message: 'Invalid decision. Must be "approve" or "reject".' });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const item = order.items.find((i) => i.orderItemId === orderItemId);
    if (!item) return res.status(404).json({ message: "Order item not found" });

    // ===== helper: kiểm tra fulfillment_file có ít nhất 1 URL hợp lệ =====
    const hasAnyFulfillmentUrl = (ff) => {
      if (!ff) return false;
      if (ff instanceof Map) {
        for (const v of ff.values()) if (v) return true;
        return false;
      }
      if (typeof ff === "object" && !Array.isArray(ff)) {
        return Object.values(ff).some(Boolean);
      }
      if (typeof ff === "string") return !!ff;
      return false;
    };

    if (d === "reject") {
      item.scale_status = "QC Rejected";
      // Xoá sạch file in để tránh lẫn với vòng duyệt sau
      item.fulfillment_file = new Map();
      item.markModified("fulfillment_file");
      if (note) item.qc_note = note;

      // Cập nhật trạng thái tổng thể
      order.scale_overall_status = "QC Rejected";
      await order.save();
      return res.json({
        message: "Scale rejected. Item set to QC Rejected.",
        item_scale_status: item.scale_status,
        qc_note: item.qc_note,
        order_scale_overall_status: order.scale_overall_status,
      });
    }

    // ====== APPROVE ======
    // Yêu cầu có ít nhất 1 nguồn in: fulfillment_file (front/back/...) hoặc svgFile (fallback)
    const hasFF = hasAnyFulfillmentUrl(item.fulfillment_file);
    const hasSvg = !!item.svgFile;
    if (!hasFF && !hasSvg) {
      return res.status(400).json({
        message:
          "Missing print files. Please upload fulfillment_file (front/back/...) or provide svgFile before approval.",
      });
    }

    item.scale_status = "Complete";
    if (note) item.qc_note = note;

    // Nếu fulfillment_file là Map rỗng và bạn vừa mới nạp file trước đó ở API khác,
    // có thể cần markModified để Mongoose ghi nhận (an toàn vẫn mark):
    item.markModified("fulfillment_file");

    // Tính trạng thái tổng thể (Ready nếu tất cả Complete)
    order.scale_overall_status = computeOverallScaleStatus(order);

    // === Nếu order đã "Ready", xác định provider và gửi ===
    if (order.scale_overall_status === "Ready") {
      let providerKey = String(provider || "").trim();

      try {
        // Nếu client không chỉ định provider, tự suy ra từ VendorProduct → Vendor
        if (!providerKey) {
          const resolved = await resolveProviderFromOrder(order, VendorProduct);
          providerKey = resolved.providerKey || providerKey; // có thể vẫn rỗng nếu không suy ra được
        }
      } catch (provErr) {
        // Có nhiều vendor khác nhau trong cùng order → yêu cầu client chỉ định rõ
        const status = provErr.status || 409;
        return res.status(status).json({
          message:
            "Unable to auto-select provider because multiple vendors were detected for this order.",
          error: provErr.message,
          providers: provErr.providers || [],
          hint: 'Please specify "provider" in request body, e.g., {"provider":"grabink"} or {"provider":"merchfox"} or {"provider":"merchize"}.',
        });
      }

      // Fallback cuối cùng
      if (!providerKey) providerKey = "grabink";

      try {
        const result = await FulfillmentService.send(order, providerKey);
        return res.json({
          message: result.alreadySent
            ? `Order already sent to ${result.vendorKey}.`
            : `Approved and order sent to ${result.vendorKey}.`,
          item_scale_status: item.scale_status,
          order_scale_overall_status: order.scale_overall_status,
          submission_vendor: result.vendorKey,
          submission_response: result.response,
        });
      } catch (e) {
        // mark Failed + lưu last_response theo providerKey (idempotent per vendor)
        const prev = order.vendor_submissions?.[providerKey] || {};
        const rec = {
          ...(prev || {}),
          sent: false,
          attempt_count: (prev?.attempt_count || 0) + 1,
          last_response: { error: e.message, at: new Date() },
        };
        order.vendor_submissions = order.vendor_submissions || {};
        order.vendor_submissions[providerKey] = rec;

        if (providerKey === "grabink") {
          order.grabink_submission = rec; // backward-compat
        }

        order.scale_overall_status = "Failed";
        await order.save();
        return res.status(502).json({
          message: `Approved but sending order to ${providerKey} failed. Overall status set to Failed.`,
          error: e.message,
        });
      }
    }

    // Chưa đủ Complete (đơn nhiều item)
    await order.save();
    return res.json({
      message: "Item approved. Waiting for other items to be approved.",
      item_scale_status: item.scale_status,
      order_scale_overall_status: order.scale_overall_status,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Confirm failed", error: err.message });
  }
};

// Retry gửi đơn sang vendor cụ thể (auto-resolve nếu không truyền provider)
const retrySendFulfillment = async (req, res) => {
  try {
    const { orderId } = req.params;
    let providerKey = String(req.query.provider || req.body?.provider || "")
      .trim()
      .toLowerCase(); // optional

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Danh sách provider hợp lệ từ service (tránh hard-code)
    const AVAILABLE_PROVIDERS = (FulfillmentService.PROVIDERS || []).map(
      (p) => p.key
    );
    const providersHint = AVAILABLE_PROVIDERS.length
      ? AVAILABLE_PROVIDERS.join(" | ")
      : "grabink | merchfox | merchize";

    // 1) Nếu không truyền provider, auto-resolve từ VendorProduct → Vendor
    if (!providerKey) {
      try {
        const resolved = await resolveProviderFromOrder(order, VendorProduct);
        providerKey = (resolved.providerKey || "").toLowerCase();
      } catch (provErr) {
        // Trường hợp có nhiều vendor trong cùng đơn
        const status = provErr.status || 409;
        return res.status(status).json({
          message:
            "Unable to auto-select provider because multiple vendors were detected for this order.",
          error: provErr.message,
          providers: provErr.providers || [],
          hint: `Please specify "provider" in query/body, e.g., ?provider=${providersHint}`,
        });
      }
    }

    // 2) Không fallback về grabink nữa. Nếu chưa xác định được, yêu cầu client chỉ định rõ.
    if (!providerKey) {
      return res.status(409).json({
        message: "Unable to determine provider automatically.",
        hint: `Please specify "provider" in query/body, e.g., ?provider=${providersHint}`,
      });
    }

    // 2.1) Validate provider hợp lệ
    if (
      AVAILABLE_PROVIDERS.length &&
      !AVAILABLE_PROVIDERS.includes(providerKey)
    ) {
      return res.status(400).json({
        message: `Unknown provider: ${providerKey}`,
        hint: `Valid providers: ${providersHint}`,
      });
    }

    // 3) Kiểm tra điều kiện retry theo trạng thái tổng
    const okToSend =
      order.scale_overall_status === "Ready" ||
      order.scale_overall_status === "Failed";
    if (!okToSend) {
      return res.status(409).json({
        message: "Order is not ready to send.",
        scale_overall_status: order.scale_overall_status,
        provider: providerKey,
      });
    }

    // 4) Idempotency theo provider
    const submissions = order.vendor_submissions || {};
    const sub =
      submissions[providerKey] ||
      (providerKey === "grabink" ? order.grabink_submission : null);
    const alreadySent = !!sub?.sent;
    if (alreadySent) {
      return res.status(409).json({
        message: `Order already sent to ${providerKey}.`,
        provider: providerKey,
        last_response: sub?.last_response || null,
        sent_at: sub?.sent_at || null,
      });
    }

    // 5) Gửi lại
    const result = await FulfillmentService.send(order, providerKey);
    return res.json({
      message: result.alreadySent
        ? `Order already sent to ${result.vendorKey}.`
        : `Order sent to ${result.vendorKey}.`,
      provider: result.vendorKey,
      submission_response: result.response,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Retry failed", error: err.message });
  }
};

// ============================
// LIST — khớp chuẩn STATISTICS
// ============================

// ===== Helper: chấp nhận role là string hoặc array, không phân biệt hoa/thường
function hasRole(userRole, target) {
  if (!userRole) return false;
  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase();
  const wanted = norm(target);
  return Array.isArray(userRole)
    ? userRole.some((r) => norm(r) === wanted)
    : norm(userRole) === wanted;
}

const getScaleList = async (req, res) => {
  try {
    const {
      page = 1,
      perPage = 10,
      from,
      to,
      scale_status,
      search,
      shopName,
      // NEW: param lọc theo asin_type của Listing
      pngStatus, // "true" | "false"
    } = req.query;

    const KNOWN = [
      "Need Scale",
      "Pending",
      "Ready",
      "Sent",
      "Failed",
      "QC Rejected",
    ];

    const canon = (s) => {
      const t = String(s || "").trim();
      if (!t) return "";
      if (/^complete$/i.test(t)) return "Ready";
      if (/^qc\s*reject(?:ed)?$/i.test(t)) return "QC Rejected";
      return t;
    };

    // ===== RBAC =====
    const userId = req.user?.userId || "";
    const userRole = req.user?.role; // string hoặc array
    const isAdmin = hasRole(userRole, "Admin");
    const isSeller = hasRole(userRole, "Seller");
    const isCS = hasRole(userRole, "Customer Service");

    // Cho phép Admin, Seller, Customer Service
    if (!(isAdmin || isSeller || isCS)) {
      return res
        .status(403)
        .json({ message: "Access denied: insufficient permissions" });
    }

    // 1) Match theo thời gian + seller filter (CHỈ filter khi là Seller thuần)
    const initialMatch = {};
    if (from && to) {
      initialMatch.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    const shouldRestrictToSeller = isSeller && !isAdmin && !isCS;
    if (shouldRestrictToSeller) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      initialMatch.sellerId = new mongoose.Types.ObjectId(userId);
    }

    // 2) Base pipeline
    const pipeline = [
      { $match: initialMatch },

      // Join shop
      {
        $lookup: {
          from: "shops",
          localField: "shopId",
          foreignField: "_id",
          as: "shop",
        },
      },
      { $unwind: { path: "$shop", preserveNullAndEmptyArrays: true } },

      // populate seller
      {
        $lookup: {
          from: "users",
          localField: "sellerId",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },

      // Filter shopName
      ...(shopName && shopName.trim()
        ? [
            {
              $match: {
                "shop.name": { $regex: new RegExp(shopName.trim(), "i") },
              },
            },
          ]
        : []),

      // Filter search (mở rộng thêm seller)
      ...(() => {
        if (!search || !search.trim()) return [];
        const keyword = new RegExp(search.trim(), "i");
        return [
          {
            $match: {
              $or: [
                { orderId: keyword },
                { "items.sku": keyword },
                { "items.orderItemId": keyword },
                { "customer_infor.email": keyword },
                { "customer_infor.name": keyword },
                { "seller.full_name": keyword },
                { "seller.email": keyword },
              ],
            },
          },
        ];
      })(),
    ];

    // NEW ===== pngStatus: lọc theo asin_type của Listing (Custom Image | Outline)
    // Mặc định (pngStatus !== 'true') -> LOẠI TRỪ các order có asin_type 'Custom Image' | 'Outline'
    // Khi pngStatus === 'true' -> CHỈ LẤY các order này
    const wantPngStatus = String(pngStatus || "false").toLowerCase() === "true";
    pipeline.push(
      {
        $lookup: {
          from: "listings",
          let: { listingIds: "$items.listingId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $in: ["$_id", { $ifNull: ["$$listingIds", []] }] },
                    { $in: ["$asin_type", ["Custom Image", "Outline"]] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "pngListings",
        },
      },
      {
        $addFields: { hasPngAsinType: { $gt: [{ $size: "$pngListings" }, 0] } },
      },
      wantPngStatus
        ? { $match: { hasPngAsinType: true } }
        : { $match: { hasPngAsinType: { $ne: true } } },
      { $unset: "pngListings" }
    );
    // ===== end NEW

    // Chuẩn hoá bucket
    pipeline.push({
      $addFields: {
        hasPendingItem: {
          $anyElementTrue: {
            $map: {
              input: "$items",
              as: "it",
              in: { $eq: ["$$it.scale_status", "Pending"] },
            },
          },
        },
        overall_status_bucket: {
          $let: {
            vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
            in: { $cond: [{ $in: ["$$s", KNOWN] }, "$$s", "Other"] },
          },
        },
      },
    });

    // 3) Áp filter theo bucket
    let onlyPending = false;
    if (scale_status && String(scale_status).trim() !== "") {
      if (/^all$/i.test(scale_status.trim())) {
        pipeline.push({
          $match: {
            overall_status_bucket: {
              $in: ["Need Scale", "Pending", "Sent", "QC Rejected"],
            },
          },
        });
      } else {
        const wanted = String(scale_status)
          .split(",")
          .map(canon)
          .filter(Boolean);
        const valid = wanted.filter((v) => KNOWN.includes(v));
        if (valid.length > 0) {
          pipeline.push({ $match: { overall_status_bucket: { $in: valid } } });
          onlyPending = valid.length === 1 && valid[0] === "Pending";
        } else {
          pipeline.push({ $match: { overall_status_bucket: "__NO_MATCH__" } });
        }
      }
    } else {
      pipeline.push({
        $match: {
          overall_status_bucket: {
            $in: ["Need Scale", "Pending", "Sent", "QC Rejected"],
          },
        },
      });
    }

    if (onlyPending) {
      pipeline.push({ $match: { hasPendingItem: true } });
    }

    // 5) Join Case
    pipeline.push({
      $lookup: {
        from: "cases",
        localField: "case",
        foreignField: "_id",
        as: "case",
      },
    });

    // --- Count ---
    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await OrderCustomProduct.aggregate(countPipeline);
    const totalCount = countResult?.[0]?.total || 0;

    // --- Paginate ---
    const isAll = String(perPage).toLowerCase() === "all";
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = isAll ? totalCount || 1 : parseInt(perPage, 10) || 10;
    const skip = isAll ? 0 : (pageNum - 1) * limitNum;

    pipeline.push({ $sort: { createdAt: -1 } });
    if (!isAll) pipeline.push({ $skip: skip }, { $limit: limitNum });

    const orders = await OrderCustomProduct.aggregate(pipeline);

    // === Map vendor product name (giữ nguyên logic cũ) ===
    const vendorIdSet = new Set();
    for (const o of orders) {
      for (const it of o.items || []) {
        const vId = it?.cost_breakdown?.vendorProductId;
        if (vId) vendorIdSet.add(String(vId));
      }
    }

    let vendorFullNameMap = new Map();
    if (vendorIdSet.size > 0) {
      const idObjs = [];
      for (const id of vendorIdSet) {
        if (mongoose.Types.ObjectId.isValid(id))
          idObjs.push(new mongoose.Types.ObjectId(id));
      }
      if (idObjs.length > 0) {
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
    }

    const listingIdSet = new Set();
    for (const o of orders) {
      for (const it of o.items || []) {
        const lid = it?.listingId;
        if (lid) listingIdSet.add(String(lid));
      }
    }

    // Query Listing 1 lần và map theo _id (giữ nguyên)
    let listingMap = new Map();
    if (listingIdSet.size > 0) {
      const ids = [];
      for (const id of listingIdSet) {
        if (mongoose.Types.ObjectId.isValid(id))
          ids.push(new mongoose.Types.ObjectId(id));
      }
      if (ids.length > 0) {
        const listings = await Listing.find({ _id: { $in: ids } })
          .select("asin_type product_image psd")
          .lean();
        listingMap = new Map(listings.map((l) => [String(l._id), l]));
      }
    }

    const result = orders.map((order) => {
      const items = (order.items || []).map((item) => {
        const surfaces = item.version3Data?.customizationInfo?.surfaces || [];
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

        const ldoc = item?.listingId
          ? listingMap.get(String(item.listingId))
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
        seller: order.seller
          ? {
              _id: order.seller._id,
              full_name: order.seller.full_name,
              email: order.seller.email,
            }
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
    console.error("❌ getScaleList error:", error);
    res
      .status(500)
      .json({ message: "Failed to retrieve scale list", error: error.message });
  }
};

const getScaleListForDesign = async (req, res) => {
  try {
    const {
      page = 1,
      perPage = 10,
      from,
      to,
      scale_status,
      search,
      shopName,
      pngStatus,
      asin_type,
      // NEW: chỉ lấy các order "Unassigned" khi = "true"
      unassigned = "", // "" | "true"
    } = req.query;

    const KNOWN = [
      "Need Scale",
      "Pending",
      "Ready",
      "Sent",
      "Failed",
      "QC Rejected",
    ];

    const canon = (s) => {
      const t = String(s || "").trim();
      if (!t) return "";
      if (/^complete$/i.test(t)) return "Ready";
      if (/^qc\s*reject(?:ed)?$/i.test(t)) return "QC Rejected";
      return t;
    };

    // ===== RBAC =====
    const userRole = req.user?.role; // string hoặc array
    const userId = req.user?.userId || "";

    const isAdmin = /^admin$/i.test(userRole);
    const isSeller = /^seller$/i.test(userRole);
    const isDesigner = /^design(?:er)?$/i.test(userRole);
    const isDesignLeader = /^design\s*leader$/i.test(userRole);

    if (!isAdmin && !isSeller && !isDesigner && !isDesignLeader) {
      return res
        .status(403)
        .json({ message: "Access denied: insufficient permissions" });
    }

    // ===== Match theo role =====
    const initialMatch = {};
    if (from && to) {
      initialMatch.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    if (isSeller) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      initialMatch.sellerId = new mongoose.Types.ObjectId(userId);
    } else if (isDesigner) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      // Designer chỉ xem order đã được assign cho chính họ
      initialMatch.scaleId = new mongoose.Types.ObjectId(userId);
    }
    // Admin + Design Leader xem tất cả

    // ===== Base pipeline =====
    const pipeline = [
      { $match: initialMatch },

      // Join shop
      {
        $lookup: {
          from: "shops",
          localField: "shopId",
          foreignField: "_id",
          as: "shop",
        },
      },
      { $unwind: { path: "$shop", preserveNullAndEmptyArrays: true } },

      // populate seller
      {
        $lookup: {
          from: "users",
          localField: "sellerId",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },

      // populate scale_by (user từ scaleId)
      {
        $lookup: {
          from: "users",
          localField: "scaleId",
          foreignField: "_id",
          as: "scale_by",
        },
      },
      { $unwind: { path: "$scale_by", preserveNullAndEmptyArrays: true } },

      // Filter shopName
      ...(shopName && shopName.trim()
        ? [
            {
              $match: {
                "shop.name": { $regex: new RegExp(shopName.trim(), "i") },
              },
            },
          ]
        : []),

      // Filter search
      ...(() => {
        if (!search || !search.trim()) return [];
        const keyword = new RegExp(search.trim(), "i");
        return [
          {
            $match: {
              $or: [
                { orderId: keyword },
                { "items.sku": keyword },
                { "items.orderItemId": keyword },
                { "customer_infor.email": keyword },
                { "customer_infor.name": keyword },
                { "seller.full_name": keyword },
                { "seller.email": keyword },
              ],
            },
          },
        ];
      })(),
    ];

    // ===== asin_type / pngStatus =====
    const normAsinType = (s) => {
      const t = String(s || "")
        .trim()
        .toLowerCase();
      if (t === "custom image" || t === "custom_image" || t === "custom-image")
        return "Custom Image";
      if (t === "outline") return "Outline";
      return null;
    };

    const asinTypesRequested = (asin_type || "")
      .split(",")
      .map((x) => normAsinType(x))
      .filter(Boolean);

    if (asinTypesRequested.length > 0) {
      pipeline.push(
        {
          $lookup: {
            from: "listings",
            let: { listingIds: "$items.listingId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $in: ["$_id", { $ifNull: ["$$listingIds", []] }] },
                      { $in: ["$asin_type", asinTypesRequested] },
                    ],
                  },
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "typeFilteredListings",
          },
        },
        {
          $addFields: {
            hasWantedAsinType: { $gt: [{ $size: "$typeFilteredListings" }, 0] },
          },
        },
        { $match: { hasWantedAsinType: true } },
        { $unset: "typeFilteredListings" }
      );
    } else {
      const wantPngStatus =
        String(pngStatus || "false").toLowerCase() === "true";
      pipeline.push(
        {
          $lookup: {
            from: "listings",
            let: { listingIds: "$items.listingId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $in: ["$_id", { $ifNull: ["$$listingIds", []] }] },
                      { $in: ["$asin_type", ["Custom Image", "Outline"]] },
                    ],
                  },
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "pngListings",
          },
        },
        {
          $addFields: {
            hasPngAsinType: { $gt: [{ $size: "$pngListings" }, 0] },
          },
        },
        wantPngStatus
          ? { $match: { hasPngAsinType: true } }
          : { $match: { hasPngAsinType: { $ne: true } } },
        { $unset: "pngListings" }
      );
    }

    // ===== Unassigned filter (cấp ORDER) =====
    // - unassigned === "true" => chỉ lấy order chưa có scaleId (missing/null/"")
    //   hoặc assignment_status === "Unassigned"
    // - Với designer: bỏ qua filter này để không xung đột với initialMatch.scaleId = userId
    if (!isDesigner && String(unassigned || "").toLowerCase() === "true") {
      pipeline.push({
        $match: {
          $or: [
            { scaleId: { $exists: false } },
            { scaleId: null },
            { scaleId: "" },
            { assignment_status: "Unassigned" }, // nếu có field này
          ],
        },
      });
    }

    // ===== Bucket status =====
    pipeline.push({
      $addFields: {
        hasPendingItem: {
          $anyElementTrue: {
            $map: {
              input: "$items",
              as: "it",
              in: { $eq: ["$$it.scale_status", "Pending"] },
            },
          },
        },
        overall_status_bucket: {
          $let: {
            vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
            in: { $cond: [{ $in: ["$$s", KNOWN] }, "$$s", "Other"] },
          },
        },
      },
    });

    let onlyPending = false;
    if (scale_status && String(scale_status).trim() !== "") {
      if (/^all$/i.test(scale_status.trim())) {
        pipeline.push({
          $match: {
            overall_status_bucket: {
              $in: ["Need Scale", "Pending", "Sent", "QC Rejected"],
            },
          },
        });
      } else {
        const wanted = String(scale_status)
          .split(",")
          .map(canon)
          .filter(Boolean);
        const valid = wanted.filter((v) => KNOWN.includes(v));
        if (valid.length > 0) {
          pipeline.push({ $match: { overall_status_bucket: { $in: valid } } });
          onlyPending = valid.length === 1 && valid[0] === "Pending";
        } else {
          pipeline.push({ $match: { overall_status_bucket: "__NO_MATCH__" } });
        }
      }
    } else {
      pipeline.push({
        $match: {
          overall_status_bucket: {
            $in: ["Need Scale", "Pending", "Sent", "QC Rejected"],
          },
        },
      });
    }
    if (onlyPending) pipeline.push({ $match: { hasPendingItem: true } });

    // Join Case
    pipeline.push({
      $lookup: {
        from: "cases",
        localField: "case",
        foreignField: "_id",
        as: "case",
      },
    });

    // --- Count ---
    const countPipeline = [...pipeline, { $count: "total" }];
    const countResult = await OrderCustomProduct.aggregate(countPipeline);
    const totalCount = countResult?.[0]?.total || 0;

    // --- Paginate ---
    const isAll = String(perPage).toLowerCase() === "all";
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = isAll ? totalCount || 1 : parseInt(perPage, 10) || 10;
    const skip = isAll ? 0 : (pageNum - 1) * limitNum;

    pipeline.push({ $sort: { createdAt: -1 } });
    if (!isAll) pipeline.push({ $skip: skip }, { $limit: limitNum });

    const orders = await OrderCustomProduct.aggregate(pipeline);

    // === Map vendor + listings ===
    const vendorIdSet = new Set();
    for (const o of orders) {
      for (const it of o.items || []) {
        const vId = it?.cost_breakdown?.vendorProductId;
        if (vId) vendorIdSet.add(String(vId));
      }
    }

    let vendorFullNameMap = new Map();
    if (vendorIdSet.size > 0) {
      const idObjs = [];
      for (const id of vendorIdSet) {
        if (mongoose.Types.ObjectId.isValid(id))
          idObjs.push(new mongoose.Types.ObjectId(id));
      }
      if (idObjs.length > 0) {
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
      const ids = [];
      for (const id of listingIdSet) {
        if (mongoose.Types.ObjectId.isValid(id))
          ids.push(new mongoose.Types.ObjectId(id));
      }
      if (ids.length > 0) {
        const listings = await Listing.find({ _id: { $in: ids } })
          .select("asin_type product_image psd")
          .lean();
        listingMap = new Map(listings.map((l) => [String(l._id), l]));
      }
    }

    // === Final mapping ===
    const result = orders.map((order) => {
      const items = (order.items || []).map((item) => {
        const surfaces = item.version3Data?.customizationInfo?.surfaces || [];
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

        const ldoc = item?.listingId
          ? listingMap.get(String(item.listingId))
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
        _id: order._id,
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
        seller: order.seller
          ? {
              _id: order.seller._id,
              full_name: order.seller.full_name,
              email: order.seller.email,
            }
          : null,
        scale_by: order.scale_by
          ? {
              _id: order.scale_by._id,
              full_name: order.scale_by.full_name,
              email: order.scale_by.email,
            }
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
    console.error("❌ getScaleListForDesign error:", error);
    res
      .status(500)
      .json({ message: "Failed to retrieve scale list", error: error.message });
  }
};

// ============================
// STATISTICS — giữ nguyên chuẩn
// ============================
async function getScaleStatistics(req, res) {
  try {
    const {
      from,
      to,
      search,
      shopName,
      breakdown,
      timeseries = "false",
      pngStatus, // NEW
    } = req.query;

    const KNOWN = [
      "Need Scale",
      "Pending",
      "Ready",
      "Sent",
      "Failed",
      "QC Rejected",
    ];

    // ===== RBAC =====
    const userRole = req.user?.role; // string hoặc array
    const userId = req.user?.userId || "";

    const isAdmin = hasRole(userRole, "Admin");
    const isSeller = hasRole(userRole, "Seller");
    const isCS = hasRole(userRole, "Customer Service");

    // Chỉ cho phép Admin, Seller, Customer Service
    if (!(isAdmin || isSeller || isCS)) {
      return res
        .status(403)
        .json({ message: "Access denied: insufficient permissions" });
    }

    // ===== Base match (time range + seller protection) =====
    // Match theo thời gian + giới hạn seller (chỉ khi là Seller thuần)
    const matchStage = {};
    if (from && to) {
      matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    const shouldRestrictToSeller = isSeller && !isAdmin && !isCS;
    if (shouldRestrictToSeller) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      matchStage.sellerId = new mongoose.Types.ObjectId(userId);
    }

    // ===== Search =====
    // Search mở rộng
    let searchOr = null;
    if (search && search.trim() !== "") {
      const keyword = new RegExp(search.trim(), "i");
      searchOr = [
        { orderId: keyword },
        { "items.sku": keyword },
        { "items.orderItemId": keyword },
        { "customer_infor.email": keyword },
        { "customer_infor.name": keyword },
        // có thể thêm seller nếu cần:
        // { "seller.full_name": keyword },
        // { "seller.email": keyword },
      ];
    }

    // ===== Base pipeline =====
    // Base pipeline
    const basePipeline = [
      { $match: matchStage },

      // Join shop
      {
        $lookup: {
          from: "shops",
          localField: "shopId",
          foreignField: "_id",
          as: "shop",
        },
      },
      { $unwind: { path: "$shop", preserveNullAndEmptyArrays: true } },

      // Filter shopName

      // (Tuỳ chọn) nếu cần search theo seller.* thì join users:
      // {
      //   $lookup: {
      //     from: "users",
      //     localField: "sellerId",
      //     foreignField: "_id",
      //     as: "seller",
      //   },
      // },
      // { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },

      ...(shopName && shopName.trim()
        ? [
            {
              $match: {
                "shop.name": { $regex: new RegExp(shopName.trim(), "i") },
              },
            },
          ]
        : []),

      // Filter search

      ...(searchOr ? [{ $match: { $or: searchOr } }] : []),
    ];

    // ===== NEW: pngStatus filter theo asin_type trong Listing =====
    // Mặc định (pngStatus !== 'true') -> LOẠI TRỪ các order có asin_type 'Custom Image' | 'Outline'
    // Khi pngStatus === 'true' -> CHỈ LẤY các order này
    const wantPngStatus = String(pngStatus || "false").toLowerCase() === "true";
    basePipeline.push(
      {
        $lookup: {
          from: "listings",
          let: { listingIds: "$items.listingId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $in: ["$_id", { $ifNull: ["$$listingIds", []] }] },
                    { $in: ["$asin_type", ["Custom Image", "Outline"]] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: "pngListings",
        },
      },
      {
        $addFields: { hasPngAsinType: { $gt: [{ $size: "$pngListings" }, 0] } },
      },
      wantPngStatus
        ? { $match: { hasPngAsinType: true } }
        : { $match: { hasPngAsinType: { $ne: true } } },
      { $unset: "pngListings" }
    );
    // ===== end NEW =====

    // Chuẩn hoá bucket + flag hasPendingItem
    basePipeline.push({
      $addFields: {
        hasPendingItem: {
          $anyElementTrue: {
            $map: {
              input: "$items",
              as: "it",
              in: { $eq: ["$$it.scale_status", "Pending"] },
            },
          },
        },
        overall_status_bucket: {
          $let: {
            vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
            in: { $cond: [{ $in: ["$$s", KNOWN] }, "$$s", "Other"] },
          },
        },
      },
    });

    // ===== Overall counts (Pending chỉ tính khi có item Pending) =====
    const overallPipeline = [
      ...basePipeline,
      {
        $group: {
          _id: "$overall_status_bucket",
          orders: { $sum: 1 },
          pendingAdj: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$overall_status_bucket", "Pending"] },
                    "$hasPendingItem",
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: "$orders" },
          byStatus: { $push: { k: "$_id", v: "$orders" } },
          pendingAdj: { $sum: "$pendingAdj" },
        },
      },
      {
        $project: {
          _id: 0,
          totalOrders: 1,
          counts: {
            $mergeObjects: [
              { $arrayToObject: "$byStatus" },
              { Pending: "$pendingAdj" }, // overwrite Pending bằng pendingAdj
            ],
          },
        },
      },
    ];

    const [overallRaw] = await OrderCustomProduct.aggregate(overallPipeline);

    const normalizeCounts = (c = {}) => {
      const counts = {
        "Need Scale": c["Need Scale"] || 0,
        Pending: c["Pending"] || 0,
        Ready: c["Ready"] || 0,
        Sent: c["Sent"] || 0,
        Failed: c["Failed"] || 0,
        "QC Rejected": c["QC Rejected"] || 0,
        Other: c["Other"] || 0,
      };
      // All = Need Scale + Pending + Sent + QC Rejected (theo quy ước hiện tại)
      counts["All"] =
        counts["Need Scale"] +
        counts["Pending"] +
        counts["Sent"] +
        counts["QC Rejected"];
      return counts;
    };

    const overall = {
      totalOrders: overallRaw?.totalOrders || 0,
      counts: normalizeCounts(overallRaw?.counts || {}),
    };

    // Giữ nguyên: breakdown/timeseries chưa xây
    return res.json({ overall, breakdown: [], timeseries: [] });
  } catch (error) {
    console.error("❌ getScaleStatistics error:", error);
    return res.status(500).json({
      message: "Failed to retrieve scale statistics by scale_overall_status",
      error: error.message,
    });
  }
}

async function getScaleStatisticsForDesign(req, res) {
  try {
    const {
      from,
      to,
      search,
      shopName,
      breakdown,
      timeseries = "false",
      pngStatus,
      asin_type,
      unassigned = "", // "" | "true"
    } = req.query;

    const KNOWN = [
      "Need Scale",
      "Pending",
      "Ready",
      "Sent",
      "Failed",
      "QC Rejected",
    ];

    // ===== RBAC =====
    const role = req.user?.role || "";
    const userId = req.user?.userId || "";

    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);
    const isDesigner = /^design(?:er)?$/i.test(role);
    const isDesignLeader = /^design\s*leader$/i.test(role);

    if (!isAdmin && !isSeller && !isDesigner && !isDesignLeader) {
      return res
        .status(403)
        .json({ message: "Access denied: insufficient permissions" });
    }

    // ===== Base match (time range + role filter) =====
    const matchStage = {};
    if (from && to) {
      matchStage.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    if (isSeller) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      matchStage.sellerId = new mongoose.Types.ObjectId(userId);
    } else if (isDesigner) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ message: "Invalid user id in token" });
      }
      matchStage.scaleId = new mongoose.Types.ObjectId(userId);
    }

    // ===== Search filter =====
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

    // ===== Base pipeline =====
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

      // Filter search
      ...(searchOr ? [{ $match: { $or: searchOr } }] : []),
    ];

    // ===== asin_type / pngStatus handling =====
    const normalizeAsinTypeToken = (s) => {
      if (!s) return null;
      const t = String(s).trim().toLowerCase();
      if (t === "custom image" || t === "custom_image" || t === "custom-image")
        return "Custom Image";
      if (t === "outline") return "Outline";
      return s.trim();
    };

    const asinTypesRequested = String(asin_type || "")
      .split(",")
      .map((x) => normalizeAsinTypeToken(x))
      .filter(Boolean);

    const hasAsinTypeFilter = asinTypesRequested.length > 0;
    const wantPngStatus = String(pngStatus || "false").toLowerCase() === "true";

    if (hasAsinTypeFilter) {
      basePipeline.push(
        {
          $lookup: {
            from: "listings",
            let: { listingIds: "$items.listingId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $in: ["$_id", { $ifNull: ["$$listingIds", []] }] },
                      { $in: ["$asin_type", asinTypesRequested] },
                    ],
                  },
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "typeFilteredListings",
          },
        },
        {
          $addFields: {
            hasWantedAsinType: { $gt: [{ $size: "$typeFilteredListings" }, 0] },
          },
        },
        { $match: { hasWantedAsinType: true } },
        { $unset: "typeFilteredListings" }
      );
    } else {
      basePipeline.push(
        {
          $lookup: {
            from: "listings",
            let: { listingIds: "$items.listingId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $in: ["$_id", { $ifNull: ["$$listingIds", []] }] },
                      { $in: ["$asin_type", ["Custom Image", "Outline"]] },
                    ],
                  },
                },
              },
              { $project: { _id: 1 } },
            ],
            as: "pngListings",
          },
        },
        {
          $addFields: {
            hasPngAsinType: { $gt: [{ $size: "$pngListings" }, 0] },
          },
        },
        wantPngStatus
          ? { $match: { hasPngAsinType: true } }
          : { $match: { hasPngAsinType: { $ne: true } } },
        { $unset: "pngListings" }
      );
    }

    // ===== bucket & counts =====
    basePipeline.push({
      $addFields: {
        hasPendingItem: {
          $anyElementTrue: {
            $map: {
              input: "$items",
              as: "it",
              in: { $eq: ["$$it.scale_status", "Pending"] },
            },
          },
        },
        overall_status_bucket: {
          $let: {
            vars: { s: { $ifNull: ["$scale_overall_status", "Need Scale"] } },
            in: { $cond: [{ $in: ["$$s", KNOWN] }, "$$s", "Other"] },
          },
        },
        // NEW: đánh dấu Unassigned
        isUnassigned: {
          $or: [
            { $not: ["$scaleId"] },
            { $eq: ["$scaleId", null] },
            { $eq: ["$scaleId", ""] },
            { $eq: ["$assignment_status", "Unassigned"] },
          ],
        },
      },
    });

    const overallPipeline = [
      ...basePipeline,
      {
        $group: {
          _id: "$overall_status_bucket",
          orders: { $sum: 1 },
          pendingAdj: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$overall_status_bucket", "Pending"] },
                    "$hasPendingItem",
                  ],
                },
                1,
                0,
              ],
            },
          },
          unassignedCount: {
            $sum: { $cond: ["$isUnassigned", 1, 0] },
          },
        },
      },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: "$orders" },
          byStatus: { $push: { k: "$_id", v: "$orders" } },
          pendingAdj: { $sum: "$pendingAdj" },
          totalUnassigned: { $sum: "$unassignedCount" },
        },
      },
      {
        $project: {
          _id: 0,
          totalOrders: 1,
          totalUnassigned: 1,
          counts: {
            $mergeObjects: [
              { $arrayToObject: "$byStatus" },
              { Pending: "$pendingAdj" },
              { Unassigned: "$totalUnassigned" },
            ],
          },
        },
      },
    ];

    const [overallRaw] = await OrderCustomProduct.aggregate(overallPipeline);

    const normalizeCounts = (c = {}) => {
      const counts = {
        Unassigned: c["Unassigned"] || 0, // NEW
        "Need Scale": c["Need Scale"] || 0,
        Pending: c["Pending"] || 0,
        Ready: c["Ready"] || 0,
        Sent: c["Sent"] || 0,
        Failed: c["Failed"] || 0,
        "QC Rejected": c["QC Rejected"] || 0,
        Other: c["Other"] || 0,
      };
      counts["All"] =
        counts["Need Scale"] +
        counts["Pending"] +
        counts["Sent"] +
        counts["QC Rejected"];
      return counts;
    };

    const overall = {
      totalOrders: overallRaw?.totalOrders || 0,
      totalUnassigned: overallRaw?.totalUnassigned || 0, // NEW
      counts: normalizeCounts(overallRaw?.counts || {}),
    };

    return res.json({ overall, breakdown: [], timeseries: [] });
  } catch (error) {
    console.error("❌ getScaleStatisticsForDesign error:", error);
    return res.status(500).json({
      message: "Failed to retrieve scale statistics by scale_overall_status",
      error: error.message,
    });
  }
}

/**
 * CS cập nhật ghi chú cho 1 item
 * PUT /api/scale/orders/:orderId/items/:orderItemId/cs-note
 * Body: { cs_note: string }  // cho phép rỗng để xóa
 */
const updateCSNoteForItem = async (req, res) => {
  try {
    const { orderId, orderItemId } = req.params;
    let { cs_note } = req.body || {};

    // Chuẩn hóa & validate đơn giản
    cs_note = typeof cs_note === "string" ? cs_note.trim() : "";
    if (cs_note.length > 2000) {
      return res.status(400).json({ message: "cs_note vượt quá 2000 ký tự." });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const item = order.items.find((i) => i.orderItemId === orderItemId);
    if (!item) return res.status(404).json({ message: "Order item not found" });

    item.cs_note = cs_note; // ghi đè hoặc xóa (nếu rỗng)
    await order.save();

    return res.json({
      message: "CS note updated.",
      orderId,
      orderItemId,
      cs_note: item.cs_note,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Update CS note failed", error: err.message });
  }
};

module.exports = {
  uploadFulfillmentFileForItem,
  confirmScaleForItem,
  retrySendGrabink: retrySendFulfillment, // giờ đã hỗ trợ ?provider=
  updateCSNoteForItem,
  getScaleList,
  getScaleStatistics,
  getScaleListForDesign,
  getScaleStatisticsForDesign,
};
