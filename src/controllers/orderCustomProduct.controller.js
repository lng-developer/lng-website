const db = require("../models");
const OrderCustomProduct = db.orderCustomProduct;
const EtsyOrder = db.EtsyOrder;
const multer = require("multer");
const fs = require("fs");
const XLSX = require("xlsx");
const path = require("path");
const upload = multer({ dest: "uploads/" });
const axios = require("axios");
const sharp = require("sharp");
const MAX_CLOUDINARY_BYTES = 10 * 1024 * 1024; // 10MB theo plan hiện tại
const AdmZip = require("adm-zip");
const Shop = db.shop;
const ConfigCostCenter = db.configCostCenter;
const VendorCostCenter = db.vendorCostCenter;
const VendorProduct = db.vendorProduct;
const ConfigOptionMapping = db.configOptionMapping;
const User = db.user;
const SkuMappingConfig = db.SkuMappingConfig;
const SkuMappingEntry = db.SkuMappingEntry;
const Listing = db.listing;
const PsdTask = db.PsdTask;
const OrderHistory = db.OrderHistory;
const { logOrderHistory } = require("../service/orderHistoryLogger");
const { logOrderLifecycleEvent } = require("../service/orderLifecycleLogger");
const { buildOrderLifecyclePayload } = require("../service/orderLifecycleContext");
const logger = require("../helper/logger");
const {
  applyRulesToSku,
  buildRulesFromConfig,
} = require("../utils/skuMigrate");
const {
  AMAZON_FEE_RATE,
} = require("../utils/amazonFinance");

const {
  validateIds,
  buildInitialMatch,
  buildFilters,
  buildVendorFilter,
  buildSelectedVendorsFilter,
  buildPipeline,
  executePipeline,
  enrichOrdersData,
  getVendorProductIdsByVendorName,
  getListingIdsNoPsd,
  normalizeBool,
} = require("../helper/orderHelper");

const mongoose = require("mongoose");

require("../config/env.config")();

const ALLOWED = ["New", "Fulfilled", "Shipping", "Shipped", "Canceled", "Cancelled"];
const isCanceledStatus = (s) => s === "Canceled" || s === "Cancelled";
const norm = (s) => (ALLOWED.includes(s) ? s : "New");
const IMPORT_SCALE_STATUS = "Need Scale";
const ITEM_SCALE_STATUSES = new Set([IMPORT_SCALE_STATUS, "Pending", "Complete", "QC Rejected", "Cancelled"]);

function normalizeImportedItemScaleStatuses(orderDoc) {
  if (!orderDoc || !Array.isArray(orderDoc.items)) return false;
  let changed = false;
  for (const item of orderDoc.items) {
    if (!ITEM_SCALE_STATUSES.has(item.scale_status)) {
      item.scale_status = IMPORT_SCALE_STATUS;
      changed = true;
    }
  }
  return changed;
}

async function loadActiveSkuMappingConfigs() {
  const now = new Date();
  const configs = await SkuMappingConfig.find({
    is_active: true,
    $or: [{ valid_from: null }, { valid_from: { $lte: now } }],
    $or: [{ valid_to: null }, { valid_to: { $gte: now } }],
  })
    .sort({ priority: 1, updatedAt: -1 })
    .lean();
  return configs;
}

// giữ nguyên
async function findActivePsdTaskByListing(listingId) {
  return PsdTask.findOne({
    listing: listingId,
    status: { $nin: ["QC Passed", "Cancelled"] }, // New/Requested/... vẫn được coi là active
  }).select("_id status");
}

// ✨ NEW: tạo task ở trạng thái 'New' (không phải Requested)
async function createNewPsdTask({
  listingId,
  sellerId,
  leaderId = null,
  note = "",
}) {
  const doc = await PsdTask.create({
    listing: listingId,
    seller: sellerId || undefined,
    leader: leaderId || undefined,
    status: "New", // <= thay đổi chính
    history: [
      {
        at: new Date(),
        action: "auto_create_from_order",
        from: "Unavailable",
        to: "New", // <= thay đổi chính
        note,
      },
    ],
  });
  return doc;
}

const importOrderJson = async (req, res) => {
  try {
    const jsonData = req.body;
    const incomingSellerId = jsonData?.sellerId || null;
    const incomingShopId = jsonData?.shopId || null;

    const order = await OrderCustomProduct.findOne({
      orderId: jsonData.orderId,
    });
    if (!order) return res.status(404).json({ message: "Order ID not found" });

    const item = order.items.find(
      (i) => i.orderItemId === jsonData.orderItemId
    );
    if (!item)
      return res
        .status(404)
        .json({ message: "OrderItem ID not found in Order" });

    const asin = (jsonData.asin || item.asin || "").trim();
    if (!asin)
      return res
        .status(422)
        .json({ message: "ASIN is required to link Listing" });

    const baseImageFromPayload =
      jsonData?.customizationData?.children?.[0]?.baseImage || {};
    const incomingSnapshotImage =
      (Array.isArray(jsonData?.cloudinarySnapshots)
        ? jsonData.cloudinarySnapshots.find(Boolean)
        : "") || "";
    const baseImageUrlForCreate =
      item?.baseImage?.imageUrl ||
      baseImageFromPayload?.imageUrl ||
      incomingSnapshotImage ||
      "";

    // 🔎 tìm listing + lấy nested psd.status
    let listingDoc = await Listing.findOne({ asin }).select(
      "_id seller psd.status"
    );
    let createdListing = false;

    if (!listingDoc) {
      if (!baseImageUrlForCreate) {
        return res.status(422).json({
          message:
            "Cannot create Listing: product_image (from item.baseImage.imageUrl) is required",
          asin,
        });
      }

      // KHÔNG set psd.status ở đây (schema bạn đã default = 'Unavailable')
      const listingCreatePayload = {
        asin,
        product_image: baseImageUrlForCreate,
        asin_type: "Normal",
        platform: "Amazon",
        ...(incomingSellerId ? { seller: incomingSellerId } : {}),
        ...(incomingShopId ? { store: incomingShopId } : {}),
        template: {
          design_product: "Design",
          style: "Sweatshirt",
          ...(jsonData?.template || {}),
        },
      };

      listingDoc = await Listing.create(listingCreatePayload);
      listingDoc = await Listing.findById(listingDoc._id).select(
        "_id seller psd.status"
      );
      createdListing = true;
    }

    // link listing vào item
    if (!item.listingId || String(item.listingId) !== String(listingDoc._id)) {
      item.listingId = listingDoc._id;
      await order.save();
    }

    // 🧠 Auto-create PSD Task theo rule mới
    let createdPsdTask = false;
    let psdTaskId = null;

    const currentPsdStatus = listingDoc?.psd?.status || "Unavailable";

    if (createdListing || currentPsdStatus === "Unavailable") {
      const existActive = await findActivePsdTaskByListing(listingDoc._id);
      if (!existActive) {
        // ⬇️ đổi sang tạo 'New' thay vì 'Requested'
        const newTask = await createNewPsdTask({
          listingId: listingDoc._id,
          sellerId: listingDoc.seller || incomingSellerId || null,
          note: `Order ${order.orderId} / Item ${item.orderItemId} triggers PSD task`,
        });
        createdPsdTask = true;
        psdTaskId = String(newTask._id);
      }
    }
    // Nếu psd.status === 'Available' thì không tạo task

    // ===== Nếu item đã có customization/snapshot → dừng sớm (đã link listing) =====
    if (item.customization) {
      let snapshotBackfilled = false;
      if (!item.snapshotImage && incomingSnapshotImage) {
        item.snapshotImage = incomingSnapshotImage;
        await order.save();
        snapshotBackfilled = true;
      }

      return res.status(snapshotBackfilled ? 200 : 409).json({
        message: snapshotBackfilled
          ? "Item already has customization data. Snapshot image backfilled."
          : "Item already has customization data. Listing linked.",
        orderId: order.orderId,
        orderItemId: item.orderItemId,
        asin,
        listingLinked: true,
        listingId: String(item.listingId),
        snapshotImage: item.snapshotImage || "",
        snapshotBackfilled,
        psdStatus: listingDoc?.psd?.status || "Unavailable",
        createdPsdTask,
        psdTaskId,
      });
    }

    // ===== 1) TÍNH PHÍ TUỲ CHỌN =====
    let totalCustomizationPrice = 0;
    const options =
      jsonData?.customizationData?.children?.[0]?.children?.[0]?.children || [];
    for (const opt of options) {
      const amount = opt?.optionSelection?.additionalCost?.amount || 0;
      totalCustomizationPrice += Number(amount);
    }

    // ===== 2) MAP TUỲ CHỌN =====
    const customizationOptions = {};
    for (const opt of options) {
      const label = opt?.label;
      const sel = opt?.optionSelection;

      switch (label) {
        case "Custom Name":
          customizationOptions.customName = opt?.inputValue || "";
          break;
        case "Text Color":
          customizationOptions.textColor = sel?.name || "";
          break;
        case "Photo Options":
          customizationOptions.photoOptions = sel?.name || "";
          break;
        case "Photo Quality Enhancement":
          customizationOptions.photoQualityEnhancement = sel || null;
          break;
        case "Select Size":
          customizationOptions.sizeOption = sel || null;
          break;
        case "Select Pack":
          customizationOptions.packOption = sel || null;
          break;
        case "Priority Production":
          customizationOptions.priorityProduction = sel || null;
          break;
        default:
          if (label?.startsWith("We would be grateful")) {
            customizationOptions.thankYouMessage = sel || null;
          }
          break;
      }
    }

    // Ảnh khách upload
    const imageCustomization = options.find(
      (opt) => opt?.type === "PlacementContainerCustomization"
    );
    const imageData = imageCustomization?.children?.[0]?.image || {};
    customizationOptions.photoUploaded = {
      imageName: imageData?.imageName || "",
      buyerFilename: imageData?.buyerFilename || "",
    };

    // ===== 3) GÁN THÔNG TIN CHO ITEM =====
    item.asin = asin;
    item.customization = customizationOptions;
    item.customizationData = jsonData.customizationData || null;
    item.version3Data = jsonData["version3.0"] || null;
    item.baseImage = {
      imageUrl: baseImageFromPayload?.imageUrl || "",
      width: baseImageFromPayload?.dimension?.width || null,
      height: baseImageFromPayload?.dimension?.height || null,
    };
    item.snapshotImage =
      incomingSnapshotImage || item.snapshotImage || "";
    item.svgFile = jsonData?.customizationData?.children?.[0]?.svg || "";
    item.totalCustomizationPrice = totalCustomizationPrice;

    await order.save();

    return res.status(200).json({
      message: "Order updated successfully!",
      orderId: order.orderId,
      orderItemId: item.orderItemId,
      asin,
      listingLinked: true,
      listingId: String(item.listingId),
      totalCustomizationPrice,
      psdStatus: listingDoc?.psd?.status || "Unavailable",
      createdPsdTask,
      psdTaskId,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Failed to update order", error: error.message });
  }
};

const validateAddressWithSmarty = async (address) => {
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
};

const validateAddressByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;

    // 1. Tìm order theo ID
    const existingOrder = await OrderCustomProduct.findOne({ orderId });
    if (!existingOrder) {
      return res.status(404).json({
        message: "Order not found",
        orderId,
      });
    }
    // 3. Lấy address từ order (customer_infor)
    const address = existingOrder.customer_infor;
    if (!address) {
      return res.status(400).json({
        message: "Order does not have customer_infor to validate",
        orderId,
      });
    }

    // 4. Gọi Smarty để validate
    const validationResult = await validateAddressWithSmarty(address);

    // 5. Lưu kết quả vào order
    existingOrder.address_validation = validationResult;
    await existingOrder.save();

    // 6. Trả response
    return res.json({
      orderId,
      addressChecked: true,
      addressValid: validationResult.isValid,
      smartyResponse: validationResult.smartyResponse,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to validate address",
      error: err.message,
    });
  }
};

const markAddressValidByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({
        message: "Order not found",
        orderId,
      });
    }

    const oldAddressValid = order.address_validation?.isValid ?? null;
    const oldScaleOverallStatus = order.scale_overall_status;

    const nextScaleOverallStatus =
      oldScaleOverallStatus === "Address Invalid"
        ? "Pending"
        : oldScaleOverallStatus;

    if (oldAddressValid === true && nextScaleOverallStatus === oldScaleOverallStatus) {
      return res.status(200).json({
        message: "No change",
        orderId,
        addressValid: true,
        scale_overall_status: order.scale_overall_status,
      });
    }

    order.address_validation = {
      isValid: true,
      smartyResponse: order.address_validation?.smartyResponse ?? null,
    };
    order.scale_overall_status = nextScaleOverallStatus;
    await order.save();

    await logOrderHistory({
      orderDoc: order,
      action: "MARK_ADDRESS_VALID",
      description: "Address validation manually overridden to valid",
      changes: [
        {
          field: "address_validation.isValid",
          from: oldAddressValid,
          to: true,
        },
        ...(oldScaleOverallStatus !== nextScaleOverallStatus
          ? [
            {
              field: "scale_overall_status",
              from: oldScaleOverallStatus,
              to: nextScaleOverallStatus,
            },
          ]
          : []),
      ],
      user: req.user,
      context: {
        source: "PORTAL",
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      },
    });

    return res.status(200).json({
      message: "Order address marked as valid successfully",
      orderId,
      addressValid: true,
      scale_overall_status: order.scale_overall_status,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to mark address as valid",
      error: err.message,
    });
  }
};

// Helper: xác định validation “đủ tin cậy” hay chỉ là lỗi hệ thống/billing
function normalizeValidationResult(result) {
  // Kỳ vọng validateAddressWithSmarty trả { isValid, smartyResponse }
  // Nhưng trong thực tế có thể trả error object
  const isValid = !!result?.isValid;

  const errMsg =
    result?.smartyResponse?.error ||
    result?.smartyResponse?.errors?.[0]?.message ||
    result?.error ||
    null;

  // Smarty lỗi billing/quota (vd 402) => không kết luận invalid address
  // Bạn có thể mở rộng mapping theo response thực tế của Smarty.
  const isSystemError =
    !!errMsg &&
    (String(errMsg).includes("402") ||
      String(errMsg).toLowerCase().includes("payment") ||
      String(errMsg).toLowerCase().includes("quota") ||
      String(errMsg).toLowerCase().includes("subscription"));

  return {
    isValid,
    isSystemError,
    errorMessage: errMsg,
    raw: result,
  };
}

// Helper: concurrency pool đơn giản
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.allSettled(ret);
}

/**
 * POST /orders/address/validate-invalid
 * Query params:
 *  - shopId (optional)
 *  - from (optional ISO date)  e.g. 2025-12-01
 *  - to   (optional ISO date)
 *  - status (optional, default "New")
 *  - limit (optional, default 200, max 1000)
 *  - concurrency (optional, default 5, max 20)
 *  - force=1 (optional)  re-validate even if already has address_validation
 *  - dryRun=1 (optional)  không save DB, chỉ report
 */
const validateInvalidAddressesBatch = async (req, res) => {
  try {
    const {
      shopId,
      from,
      to,
      status = "New",
      force,
      dryRun,
      limit = 200,
      concurrency = 5,
    } = req.query;

    const nLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
    const nConcurrency = Math.min(
      Math.max(parseInt(concurrency, 10) || 5, 1),
      20
    );

    const filter = {};

    // Theo shop
    if (shopId) {
      if (!mongoose.Types.ObjectId.isValid(shopId)) {
        return res.status(400).json({ message: "Invalid shopId" });
      }
      filter.shopId = new mongoose.Types.ObjectId(shopId);
    }

    // Theo status
    if (status) filter.status = status;

    // Theo ngày purchase_date
    if (from || to) {
      filter.purchase_date = {};
      if (from) filter.purchase_date.$gte = new Date(from);
      if (to) filter.purchase_date.$lte = new Date(to);
    }

    /**
     * Điều kiện “cần check invalid”:
     * - customer_infor tồn tại
     * - Và (chưa có address_validation) OR (address_validation.isValid = false) OR (có smartyResponse.error)
     * - Nếu force=1 thì bỏ qua điều kiện đã validate, cứ recheck tất cả matching filter
     */
    filter.customer_infor = { $exists: true, $ne: null };

    if (!force) {
      filter.$or = [
        { address_validation: { $exists: false } },
        { "address_validation.isValid": false },
        {
          "address_validation.smartyResponse.error": {
            $exists: true,
            $ne: null,
          },
        },
      ];
    }

    // Lấy danh sách order cần check
    const orders = await OrderCustomProduct.find(filter)
      .select({
        orderId: 1,
        customer_infor: 1,
        address_validation: 1,
        purchase_date: 1,
        status: 1,
        shopId: 1,
      })
      .sort({ purchase_date: -1 })
      .limit(nLimit)
      .lean();

    if (!orders.length) {
      return res.json({
        matched: 0,
        checked: 0,
        updated: 0,
        invalid: 0,
        valid: 0,
        systemError: 0,
        items: [],
      });
    }

    // Thực thi validate theo pool
    const results = await asyncPool(nConcurrency, orders, async (o) => {
      const orderId = o.orderId;
      const address = o.customer_infor;

      if (!address) {
        return {
          orderId,
          checked: false,
          updated: false,
          status: "missing_address",
        };
      }

      const validationResult = await validateAddressWithSmarty(address);
      const norm = normalizeValidationResult(validationResult);

      // Nếu là system error (vd 402) => log lại, không đánh invalid, không overwrite nếu bạn không muốn
      // Ở đây mình vẫn lưu để trace (trừ khi dryRun).
      if (!dryRun) {
        await OrderCustomProduct.updateOne(
          { orderId },
          {
            $set: {
              address_validation: validationResult,
              address_validation_checked_at: new Date(),
            },
          }
        );
      }

      return {
        orderId,
        checked: true,
        updated: !dryRun,
        addressValid: norm.isValid,
        systemError: norm.isSystemError,
        errorMessage: norm.errorMessage,
      };
    });

    // Tổng hợp
    const items = results.map((r, idx) => {
      if (r.status === "fulfilled") return r.value;
      return {
        orderId: orders[idx]?.orderId,
        checked: false,
        updated: false,
        status: "exception",
        errorMessage: r.reason?.message || String(r.reason),
      };
    });

    let checked = 0,
      updated = 0,
      valid = 0,
      invalid = 0,
      systemError = 0,
      exception = 0;

    for (const it of items) {
      if (it.checked) checked += 1;
      if (it.updated) updated += 1;

      if (it.status === "exception") exception += 1;
      if (it.systemError) systemError += 1;

      // Chỉ đếm valid/invalid nếu không phải systemError
      if (it.checked && !it.systemError) {
        if (it.addressValid) valid += 1;
        else invalid += 1;
      }
    }

    return res.json({
      matched: orders.length,
      checked,
      updated,
      valid,
      invalid,
      systemError,
      exception,
      dryRun: !!dryRun,
      force: !!force,
      params: {
        shopId,
        from,
        to,
        status,
        limit: nLimit,
        concurrency: nConcurrency,
      },
      items,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to validate invalid addresses batch",
      error: err.message,
    });
  }
};
// Helper nén ảnh
async function compressToUnderLimit(buffer, maxBytes = MAX_CLOUDINARY_BYTES) {
  const widths = [2200, 2000, 1600];
  const qualities = [85, 80, 72, 65, 60, 55, 50];

  for (const w of widths) {
    for (const q of qualities) {
      const out = await sharp(buffer)
        .rotate()
        .resize({ width: w, withoutEnlargement: true })
        .jpeg({ quality: q, mozjpeg: true })
        .toBuffer();

      if (out.length <= maxBytes) return out;
    }
  }
  return null;
}

// ============================
// Helpers: parse MSNV & chọn theo majority
// ============================
function extractMSNVFromSKU(sku) {
  if (!sku || typeof sku !== "string") return null;
  const first = sku.split("-")[0]?.trim();
  if (!first) return null;
  // Chuẩn hoá: chữ hoa, bỏ khoảng trắng
  return first.toUpperCase();
}

/**
 * Chọn MSNV majority từ một mảng SKU
 * @param {string[]} skus
 * @returns {string|null} msnv (chữ hoa) hoặc null
 */
function pickMajorityMSNVFromSkus(skus = []) {
  const counts = new Map();
  for (const s of skus) {
    const msnv = extractMSNVFromSKU(s);
    if (!msnv) continue;
    counts.set(msnv, (counts.get(msnv) || 0) + 1);
  }
  if (!counts.size) return null;
  // Lấy MSNV có tần suất cao nhất
  let best = null,
    bestCnt = -1;
  for (const [k, v] of counts.entries()) {
    if (v > bestCnt) {
      best = k;
      bestCnt = v;
    }
  }
  return best;
}

/**
 * Tìm user._id theo employee_id (case-insensitive)
 * @param {string} msnv
 * @returns {Promise<ObjectId|null>}
 */
async function findSellerIdByEmployeeId(msnv) {
  if (!msnv) return null;
  // Tìm chính xác theo employee_id (không suy diễn)
  const user = await User.findOne({ employee_id: msnv }).select("_id");
  return user?._id || null;
}

function mapSkuIfAny(sku, activeConfigs = []) {
  if (!sku || !activeConfigs || activeConfigs.length === 0) return null;
  for (const cfg of activeConfigs) {
    const rules = buildRulesFromConfig(cfg);
    const r = applyRulesToSku(sku, rules);
    if (r.ok && r.changed) return r.next;
  }
  return null;
}

const num = (v) => {
  if (v == null) return 0;
  const n = +String(v).trim().replace(/[, ]/g, "");
  return Number.isFinite(n) ? n : 0;
};

const round2 = (v) => Number(num(v).toFixed(2));

const updateOrdersFromXlsx = async (req, res) => {
  try {
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows = [];
    const bodyShopId = req.body.shopId; // shopId gửi từ client
    const type = req.body.type;

    // ✅ Auto compute base-cost
    const autoCompute =
      String(req.body?.autoComputeBaseCost ?? "true") !== "false";

    // ✅ Cho phép override seller hiện tại
    const overrideSeller =
      String(req.body?.overrideSeller ?? "false") === "true";

    // ✅ Dry-run SKU Mapping
    const skuMappingDryRun =
      String(req.body?.skuMappingDryRun ?? "false") === "true";
    const skuMappingPreviewLimit = Number(
      req.body?.skuMappingPreviewLimit || 20
    );

    const ordersToCompute = new Set();
    const results = [];

    // ✅ Cache ASIN→Listing image
    const asinToListingMap = new Map();

    // 🔶 SKU-MAPPING
    const activeConfigs = await loadActiveSkuMappingConfigs();
    const pendingSkuMapLogs = [];
    const pendingMappedSkuOps = [];
    const skuMappingSamples = [];

    // ✅ Resolve mapped SKU immediately (in-memory) so we can persist mapped_sku before compute
    function resolveMappedSkuNow(sku) {
      if (!sku || !activeConfigs || activeConfigs.length === 0) return null;

      for (const cfg of activeConfigs) {
        const rules = buildRulesFromConfig(cfg);
        const r = applyRulesToSku(sku, rules);
        if (r.ok && r.changed) {
          return { mappedSku: r.next, cfg, rulesSnapshot: rules };
        }
      }
      return null;
    }

    // ✅ Gom SKU xử lý majority
    const orderIdToPreferredSkus = new Map();
    const ordersTouched = new Set();
    function pushSkuForMajority(orderId, sku) {
      if (!orderId || !sku) return;
      // prefer mapped sku for majority
      const mapping = resolveMappedSkuNow(sku);
      const preferred = mapping?.mappedSku || sku;
      const arr = orderIdToPreferredSkus.get(orderId) || [];
      arr.push(preferred);
      orderIdToPreferredSkus.set(orderId, arr);
    }

    function considerLogMapping(orderId, orderItemId, sku) {
      if (!sku || !activeConfigs || activeConfigs.length === 0) return;

      for (const cfg of activeConfigs) {
        const rules = buildRulesFromConfig(cfg);
        const r = applyRulesToSku(sku, rules);
        if (r.ok && r.changed) {
          if (skuMappingSamples.length < skuMappingPreviewLimit) {
            skuMappingSamples.push({
              orderId,
              orderItemId,
              old: sku,
              next: r.next,
              config: {
                id: String(cfg._id),
                name: cfg.name,
                priority: cfg.priority,
              },
            });
          }
          // log
          pendingSkuMapLogs.push({
            updateOne: {
              filter: { orderId, orderItemId, oldSku: sku, newSku: r.next },
              update: {
                $setOnInsert: {
                  config_id: cfg._id,
                  rulesSnapshot: rules,
                  source: "import",
                  operator: null,
                  migratedAt: new Date(),
                },
              },
              upsert: true,
            },
          });
          // update mapped_sku trên item (bulk fallback, even though we set immediately)
          pendingMappedSkuOps.push({
            updateOne: {
              filter: { orderId, "items.orderItemId": orderItemId },
              update: { $set: { "items.$.mapped_sku": r.next } },
            },
          });
          break;
        }
      }
    }

    // ====== Đọc file TXT ======
    if (ext === ".txt") {
      const raw = fs.readFileSync(filePath, "utf8");
      const delimiter = raw.includes("\t") ? "\t" : ",";
      const lines = raw.split("\n").filter((line) => line.trim() !== "");
      const headers = lines[0]
        .trim()
        .split(delimiter)
        .map((h) => h.trim().replace(/-/g, "_"));
      rows = lines.slice(1).map((line) => {
        const values = line.trim().split(delimiter);
        const obj = {};
        headers.forEach((key, index) => {
          obj[key] = values[index]?.trim() || "";
        });
        return obj;
      });
    } else {
      return res.status(400).json({ message: "Only .txt files are supported" });
    }

    // ✅ Prefetch Listing images theo ASIN
    const uniqueAsins = new Set();
    for (const row of rows) {
      const asin = row.asin?.trim();
      if (asin) uniqueAsins.add(asin);
    }
    if (uniqueAsins.size > 0) {
      const listings = await Listing.find({
        asin: { $in: Array.from(uniqueAsins) },
      })
        .select("asin product_image")
        .lean();
      for (const listing of listings) {
        if (listing.asin && listing.product_image) {
          asinToListingMap.set(listing.asin, listing.product_image);
        }
      }
      console.log(
        `[Import] Found ${asinToListingMap.size} ASIN-Listing matches from ${uniqueAsins.size} unique ASINs`
      );
    }

    // =========================
    // ✅ FINANCE HELPERS (NEW)
    // =========================
    function ensureFinance(orderDoc) {
      if (!orderDoc.amazon_finance_total) {
        orderDoc.amazon_finance_total = {
          item_price: 0,
          item_tax: 0,
          shipping_price: 0,
          shipping_tax: 0,
          item_promotion_discount: 0,
          fee: 0,
          revenue: 0,
          opCost: 0,
          refund: 0,
        };
      }
      return orderDoc.amazon_finance_total;
    }

    function addFinanceTotals(orderDoc, delta) {
      const t = ensureFinance(orderDoc);

      t.item_price = round2((t.item_price || 0) + delta.item_price);
      t.item_tax = round2((t.item_tax || 0) + delta.item_tax);
      t.shipping_price = round2((t.shipping_price || 0) + delta.shipping_price);
      t.shipping_tax = round2((t.shipping_tax || 0) + delta.shipping_tax);
      t.item_promotion_discount = round2(
        (Math.abs(t.item_promotion_discount) || 0) +
        Math.abs(delta.item_promotion_discount)
      );

      // revenue = item + shipping
      t.revenue = round2((t.revenue || 0) + delta.revenue);

      // fee = configured Amazon fee rate * revenue
      t.fee = round2(AMAZON_FEE_RATE * round2(t.revenue));
    }

    // ✅ Pre-aggregate finance theo orderId từ FILE (unique theo order_item_id)
    const orderIdToFileFinance = new Map();
    function accumulateFileFinance(row) {
      const oid = row.order_id;
      const oi = row.order_item_id;
      if (!oid || !oi) return;

      const itemPrice = round2(row.item_price);
      const shippingPrice = round2(row.shipping_price);
      const revenue = round2(itemPrice + shippingPrice);
      const itemTax = round2(row.item_tax);
      const shippingTax = round2(row.shipping_tax);
      const discount = round2(row.item_promotion_discount);

      let bucket = orderIdToFileFinance.get(oid);
      if (!bucket) {
        bucket = {
          seen: new Set(),
          totals: {
            item_price: 0,
            item_tax: 0,
            shipping_price: 0,
            shipping_tax: 0,
            item_promotion_discount: 0,
            revenue: 0,
          },
        };
        orderIdToFileFinance.set(oid, bucket);
      }

      if (bucket.seen.has(oi)) return;
      bucket.seen.add(oi);

      bucket.totals.item_price = round2(bucket.totals.item_price + itemPrice);
      bucket.totals.item_tax = round2(bucket.totals.item_tax + itemTax);
      bucket.totals.shipping_price = round2(
        bucket.totals.shipping_price + shippingPrice
      );
      bucket.totals.shipping_tax = round2(
        bucket.totals.shipping_tax + shippingTax
      );
      bucket.totals.item_promotion_discount = round2(
        Math.abs(bucket.totals.item_promotion_discount) + Math.abs(discount)
      );
      bucket.totals.revenue = round2(bucket.totals.revenue + revenue);
    }
    for (const r of rows) accumulateFileFinance(r);

    // ====== Flow cập nhật theo Latest ship date ======
    if (type === "Latest ship date") {
      for (const row of rows) {
        const orderId = row.amazon_order_id;
        const newStatus = row.order_status?.trim();
        if (!orderId || !newStatus) continue;

        const existingOrder = await OrderCustomProduct.findOne({ orderId });
        if (existingOrder) {
          if (newStatus === "Pending") {
            results.push({ orderId, status: "skipped - pending" });
            continue;
          }
          if (existingOrder.status !== newStatus) {
            const oldStatus = existingOrder.status;
            existingOrder.status = newStatus;
            await existingOrder.save();
            results.push({
              orderId,
              status: "status updated",
              from: oldStatus,
              to: newStatus,
            });
          } else {
            results.push({ orderId, status: "skipped - same status" });
          }

          if (
            existingOrder.address_validation?.isValid === null &&
            existingOrder.address_validation?.smartyResponse === null
          ) {
            const validationResult = await validateAddressWithSmarty(
              existingOrder.customer_infor
            );
            existingOrder.address_validation = validationResult;
            await existingOrder.save();
            results.push({
              orderId,
              addressChecked: true,
              addressValid: validationResult.isValid,
            });
          }
        }
      }

      try {
        fs.unlinkSync(filePath);
      } catch (_) { }
      return res.json({
        message: "Update by latest ship date completed",
        results,
      });
    }

    // ====== Flow import mặc định ======
    for (const row of rows) {
      const orderId = row.order_id;
      if (!orderId) continue;

      ordersTouched.add(orderId);
      if (row.sku) {
        pushSkuForMajority(orderId, row.sku);
      }

      const asin = row.asin?.trim();
      const baseImageFromListing =
        asin && asinToListingMap.has(asin) ? asinToListingMap.get(asin) : null;

      // ✅ map sku BEFORE building itemData
      const mapping = resolveMappedSkuNow(row.sku);
      const mappedSku = mapping?.mappedSku || null;

      const itemData = {
        orderItemId: row.order_item_id,
        sku: row.sku,
        mapped_sku: mappedSku, // ✅ set immediately
        title: row.product_name,
        customized_url: row.customized_url,
        quantity: Number(row.quantity_purchased || 1),
        asin: asin || null,
        scale_status: IMPORT_SCALE_STATUS,
      };

      // ✅ Finance per row (item)
      const itemPrice = round2(row.item_price);
      const shippingPrice = round2(row.shipping_price);
      const revenue = round2(itemPrice + shippingPrice);
      const itemTax = round2(row.item_tax);
      const shippingTax = round2(row.shipping_tax);
      const discount = round2(row.item_promotion_discount);
      const fee = round2(AMAZON_FEE_RATE * revenue);

      const basicData = {
        orderId,
        shopId: bodyShopId, // mặc định gán theo body khi tạo mới
        purchase_date: row.purchase_date,
        customer_infor: {
          email: row.buyer_email,
          name: row.recipient_name,
          phone_number: row.ship_phone_number,
          address: row.ship_address_1,
          address_2: row.ship_address_2,
          province: row.province,
          city: row.ship_city,
          state: row.ship_state,
          zip_code: row.ship_postal_code,
          country: row.ship_country,
        },
        shipping_type: row.ship_service_level,
        base_cost: 0,
        amazon_finance_total: {
          item_price: itemPrice,
          item_tax: itemTax,
          shipping_price: shippingPrice,
          shipping_tax: shippingTax,
          item_promotion_discount: Math.abs(discount),
          fee: fee,
          revenue: revenue,
          opCost: 0,
          refund: 0,
        },
      };

      // sẽ truyền xuống importOrderJson
      let currentSellerIdForThisOrder = null;
      let currentShopIdForThisOrder = null;

      const existing = await OrderCustomProduct.findOne({ orderId });
      let skipProcessingZip = false;

      if (existing) {
        if (normalizeImportedItemScaleStatuses(existing)) {
          await existing.save();
        }
        const exists = existing.items.some(
          (i) => i.orderItemId === itemData.orderItemId
        );

        if (!exists) {
          if (baseImageFromListing) {
            itemData.baseImage = {
              imageUrl: baseImageFromListing,
              width: null,
              height: null,
            };
          }

          // Thêm item (mapped_sku already set)
          existing.items.push(itemData);

          // ✅ cộng dồn finance khi thêm item mới
          addFinanceTotals(existing, {
            item_price: itemPrice,
            item_tax: itemTax,
            shipping_price: shippingPrice,
            shipping_tax: shippingTax,
            item_promotion_discount: Math.abs(discount),
            revenue: revenue,
          });

          // ✅ set/override seller theo mapped SKU ưu tiên
          if (itemData.sku) {
            const preferredSku = itemData.mapped_sku || itemData.sku;
            const msnv = extractMSNVFromSKU(preferredSku);
            if (msnv) {
              const parsedSellerId = await findSellerIdByEmployeeId(msnv);
              if (parsedSellerId) {
                if (overrideSeller || !existing.sellerId) {
                  existing.sellerId = parsedSellerId;
                }
              }
            }
          }

          // ❗ shopId: không override nếu đã có
          if (!existing.shopId && bodyShopId) {
            existing.shopId = bodyShopId;
          }

          await existing.save();

          currentSellerIdForThisOrder = existing?.sellerId
            ? String(existing.sellerId)
            : null;
          currentShopIdForThisOrder = existing?.shopId
            ? String(existing.shopId)
            : bodyShopId
              ? String(bodyShopId)
              : null;

          results.push({
            orderId,
            status: "item added",
            baseImageFromListing: !!baseImageFromListing,
            asin: asin || null,
            mapped_sku: itemData.mapped_sku || null,
          });

          // SKU mapping logs (still queue for audit), and bulk update fallback
          considerLogMapping(orderId, itemData.orderItemId, itemData.sku);

          if (autoCompute) ordersToCompute.add(orderId);
        } else {
          // Item đã tồn tại
          const existingItem = existing.items.find(
            (i) => i.orderItemId === itemData.orderItemId
          );

          // ✅ ensure mapped_sku exists ASAP (not waiting bulkWrite)
          if (existingItem?.sku && !existingItem.mapped_sku) {
            const m = resolveMappedSkuNow(existingItem.sku);
            if (m?.mappedSku) {
              existingItem.mapped_sku = m.mappedSku;
              // queue audit logs too
              considerLogMapping(
                orderId,
                existingItem.orderItemId,
                existingItem.sku
              );
              await existing.save();
            }
          }

          if (baseImageFromListing) {
            if (
              existingItem &&
              (!existingItem.baseImage?.imageUrl ||
                existingItem.baseImage.imageUrl === "")
            ) {
              existingItem.baseImage = {
                imageUrl: baseImageFromListing,
                width: existingItem.baseImage?.width || null,
                height: existingItem.baseImage?.height || null,
              };
              existingItem.asin = asin;
              await existing.save();

              results.push({
                orderId,
                status: "item exists - base image updated from listing",
                baseImageFromListing: true,
                asin,
                mapped_sku: existingItem?.mapped_sku || null,
              });

              if (existingItem?.sku) {
                considerLogMapping(
                  orderId,
                  existingItem.orderItemId,
                  existingItem.sku
                );
              }
            } else {
              results.push({
                orderId,
                status: "item exists",
                baseImageFromListing: false,
                asin: asin || null,
                mapped_sku: existingItem?.mapped_sku || null,
              });
              if (existingItem?.sku) {
                considerLogMapping(
                  orderId,
                  existingItem.orderItemId,
                  existingItem.sku
                );
              }
            }
          } else {
            results.push({
              orderId,
              status: "item exists",
              baseImageFromListing: false,
              asin: asin || null,
              mapped_sku: existingItem?.mapped_sku || null,
            });
            if (existingItem?.sku) {
              considerLogMapping(
                orderId,
                existingItem.orderItemId,
                existingItem.sku
              );
            }
          }

          // seller/shop để truyền xuống JSON
          currentSellerIdForThisOrder = existing?.sellerId
            ? String(existing.sellerId)
            : null;
          currentShopIdForThisOrder = existing?.shopId
            ? String(existing.shopId)
            : bodyShopId
              ? String(bodyShopId)
              : null;

          skipProcessingZip = !(
            row.customized_url &&
            (!existingItem?.snapshotImage || !existingItem?.customization)
          );

          if (
            autoCompute &&
            (!existing.base_cost || existing.base_cost === 0)
          ) {
            ordersToCompute.add(orderId);
          }
        }
      } else {
        // NEW ORDER
        if (baseImageFromListing) {
          itemData.baseImage = {
            imageUrl: baseImageFromListing,
            width: null,
            height: null,
          };
        }

        const newOrder = new OrderCustomProduct({
          ...basicData,
          items: [itemData], // mapped_sku already set
        });

        // ✅ sellerId theo mapped SKU khi tạo mới
        if (itemData.sku) {
          const preferredSku = itemData.mapped_sku || itemData.sku;
          const msnv = extractMSNVFromSKU(preferredSku);
          if (msnv) {
            const parsedSellerId = await findSellerIdByEmployeeId(msnv);
            if (parsedSellerId) newOrder.sellerId = parsedSellerId;
          }
        }

        await newOrder.save();

        currentSellerIdForThisOrder = newOrder?.sellerId
          ? String(newOrder.sellerId)
          : null;
        currentShopIdForThisOrder = newOrder?.shopId
          ? String(newOrder.shopId)
          : bodyShopId
            ? String(bodyShopId)
            : null;

        const validationResult = await validateAddressWithSmarty(
          basicData.customer_infor
        );

        newOrder.address_validation = validationResult;
        await newOrder.save();

        results.push({
          orderId,
          status: "New order created with address check",
          addressValid: validationResult.isValid,
          baseImageFromListing: !!baseImageFromListing,
          asin: asin || null,
          mapped_sku: itemData.mapped_sku || null,
        });

        considerLogMapping(orderId, itemData.orderItemId, itemData.sku);
        if (autoCompute) ordersToCompute.add(orderId);
      }

      if (skipProcessingZip) continue;

      // ====== xử lý ZIP customized_url ======
      try {
        const url = row.customized_url;
        if (!url) {
          results.push({ orderId, status: "no URL" });
          continue;
        }

        const zipResponse = await axios.get(url, {
          responseType: "arraybuffer",
        });
        const zip = new AdmZip(Buffer.from(zipResponse.data));

        const allEntries = zip.getEntries();
        const imageEntries = allEntries.filter((entry) =>
          /\.(jpe?g|png)$/i.test(entry.entryName)
        );
        const jsonEntry = allEntries.find((entry) =>
          entry.entryName.endsWith(".json")
        );

        const cloudinaryUrls = [];
        const skippedSnapshots = [];

        for (const imageEntry of imageEntries) {
          try {
            const imageBuffer = imageEntry.getData();
            const imageName = path.basename(imageEntry.entryName);
            let bufferForUpload = imageBuffer;

            if (bufferForUpload.length > MAX_CLOUDINARY_BYTES) {
              const compressed = await compressToUnderLimit(
                bufferForUpload,
                MAX_CLOUDINARY_BYTES
              );
              if (!compressed) {
                skippedSnapshots.push({
                  image: imageName,
                  reason: `oversize after compress (${bufferForUpload.length} bytes)`,
                });
                continue;
              }
              bufferForUpload = compressed;
            }

            try {
              const finalName =
                bufferForUpload === imageBuffer
                  ? imageName
                  : imageName.replace(/\.(png|jpg|jpeg)$/i, "") +
                  "_compressed.jpg";

              const cloudinaryUrl = await uploadSnapshotToCloud(
                bufferForUpload,
                finalName
              );
              cloudinaryUrls.push(cloudinaryUrl);
            } catch (e) {
              const msg = String(e?.message || "");
              if (/File size too large/i.test(msg)) {
                try {
                  const lastTry = await sharp(bufferForUpload)
                    .resize({ width: 1400, withoutEnlargement: true })
                    .jpeg({ quality: 50, mozjpeg: true })
                    .toBuffer();

                  if (lastTry.length <= MAX_CLOUDINARY_BYTES) {
                    const finalName =
                      imageName.replace(/\.(png|jpg|jpeg)$/i, "") +
                      "_compressed_last.jpg";
                    const url = await uploadSnapshotToCloud(lastTry, finalName);
                    cloudinaryUrls.push(url);
                    continue;
                  }
                } catch (_) { }
                skippedSnapshots.push({
                  image: imageName,
                  reason: "cloudinary: file size too large",
                });
                continue;
              }
              skippedSnapshots.push({
                image: imageName,
                reason: `upload error: ${msg}`,
              });
              continue;
            }
          } catch (innerErr) {
            skippedSnapshots.push({
              image: imageEntry?.entryName || "<unknown>",
              reason: `unexpected: ${innerErr?.message || innerErr}`,
            });
            continue;
          }
        }

        if (!jsonEntry) {
          results.push({
            orderId,
            status: "no JSON in ZIP",
            snapshots: cloudinaryUrls,
            skippedSnapshots,
          });
          continue;
        }

        const jsonData = JSON.parse(zip.readAsText(jsonEntry));
        jsonData.cloudinarySnapshots = cloudinaryUrls;
        jsonData.skippedSnapshots = skippedSnapshots;

        // 👇 TRUYỀN sellerId + shopId xuống importOrderJson
        const fakeReq = {
          body: {
            ...jsonData,
            sellerId: currentSellerIdForThisOrder || null,
            shopId: currentShopIdForThisOrder || null,
          },
        };
        const fakeRes = {
          status: (code) => ({
            json: (msg) =>
              results.push({
                orderId,
                status: code,
                message: msg?.message || msg,
                snapshots: cloudinaryUrls,
                skippedSnapshots,
              }),
          }),
        };

        await importOrderJson(fakeReq, fakeRes);
      } catch (err) {
        results.push({ orderId, status: "failed", error: err.message });
      }
    }

    // ✅ Rebuild finance theo file cho order đang thiếu/0 revenue (không phá order đã đúng)
    for (const oid of ordersTouched) {
      const bucket = orderIdToFileFinance.get(oid);
      if (!bucket) continue;

      const doc = await OrderCustomProduct.findOne({ orderId: oid }).select(
        "_id amazon_finance_total"
      );
      if (!doc) continue;

      const currentRevenue = round2(doc?.amazon_finance_total?.revenue || 0);

      if (!doc.amazon_finance_total || currentRevenue === 0) {
        const t = bucket.totals;
        doc.amazon_finance_total = {
          item_price: round2(t.item_price),
          item_tax: round2(t.item_tax),
          shipping_price: round2(t.shipping_price),
          shipping_tax: round2(t.shipping_tax),
          item_promotion_discount: round2(Math.abs(t.item_promotion_discount)),
          revenue: round2(t.revenue),
          fee: round2(AMAZON_FEE_RATE * round2(t.revenue)),
          opCost: doc.amazon_finance_total?.opCost || 0,
          refund: doc.amazon_finance_total?.refund || 0,
        };
        await doc.save();
      }
    }

    // ====== Chốt seller theo majority SKU (tôn trọng cờ overrideSeller) ======
    const sellerAssignResults = [];
    for (const oid of ordersTouched) {
      const skus = orderIdToPreferredSkus.get(oid) || [];
      const msnv = pickMajorityMSNVFromSkus(skus);
      if (!msnv) {
        sellerAssignResults.push({
          orderId: oid,
          seller: null,
          reason: "no msnv parsed from skus",
        });
        continue;
      }

      const sellerId = await findSellerIdByEmployeeId(msnv);
      if (!sellerId) {
        sellerAssignResults.push({
          orderId: oid,
          seller: null,
          msnv,
          reason: "no user match by employee_id",
        });
        continue;
      }

      const orderDoc = await OrderCustomProduct.findOne({
        orderId: oid,
      }).select("_id sellerId");
      if (!orderDoc) {
        sellerAssignResults.push({
          orderId: oid,
          seller: null,
          msnv,
          reason: "order not found when assigning",
        });
        continue;
      }

      if (orderDoc.sellerId && !overrideSeller) {
        sellerAssignResults.push({
          orderId: oid,
          seller: String(orderDoc.sellerId),
          msnv,
          action: "kept-existing",
        });
        continue;
      }

      orderDoc.sellerId = sellerId;
      await orderDoc.save();
      sellerAssignResults.push({
        orderId: oid,
        seller: String(sellerId),
        msnv,
        action: orderDoc.sellerId ? "overridden" : "assigned",
      });
    }

    // ====== Tính base cost ======
    let baseCostResults = [];
    if (autoCompute && ordersToCompute.size > 0) {
      for (const oid of ordersToCompute) {
        const one = await new Promise((resolve) => {
          const fakeReq = {
            body: { orderId: oid },
            user: req.user,
            ip: req.ip,
            headers: req.headers,
          };
          const fakeRes = {
            json: (obj) => resolve({ orderId: oid, ...obj }),
            status: (code) => ({
              json: (obj) => resolve({ orderId: oid, code, ...obj }),
            }),
          };
          computeBaseCostForOrder(fakeReq, fakeRes);
        });
        baseCostResults.push(one);
      }
    }

    // ====== Ghi logs & mapped_sku (trừ khi dry-run) ======
    if (pendingSkuMapLogs.length > 0 && !skuMappingDryRun) {
      try {
        await SkuMappingEntry.bulkWrite(pendingSkuMapLogs, { ordered: false });
      } catch (_) { }
    }
    if (pendingMappedSkuOps.length > 0 && !skuMappingDryRun) {
      try {
        await OrderCustomProduct.bulkWrite(pendingMappedSkuOps, {
          ordered: false,
        });
      } catch (_) { }
    }

    // dọn file tạm
    try {
      fs.unlinkSync(filePath);
    } catch (_) { }

    return res.json({
      message: "Batch import completed with ASIN-Listing base image matching",
      results,
      seller_assignment: sellerAssignResults,
      base_cost_auto_computed: autoCompute,
      base_cost_results: baseCostResults,
      asin_listing_matches: asinToListingMap.size,
      // SKU-MAPPING
      sku_mapping_configs_loaded: activeConfigs.length,
      sku_mapping_logs_queued: pendingSkuMapLogs.length,
      sku_mapping_item_updates: pendingMappedSkuOps.length,
      sku_mapping_dry_run: skuMappingDryRun,
      sku_mapping_samples: skuMappingSamples,
    });
  } catch (error) {
    try {
      if (req?.file?.path) fs.unlinkSync(req.file.path);
    } catch (_) { }
    return res
      .status(500)
      .json({ message: "Batch import failed", error: error.message });
  }
};

const uploadSnapshotToCloud = async (buffer, filename) => {
  const { uploadBufferToR2 } = require("../service/cloudflareR2/r2.service");
  const up = await uploadBufferToR2({
    buffer,
    originalName: filename,
    mimeType: filename && /\.jpe?g$/i.test(filename) ? "image/jpeg" : "image/png",
    size: buffer?.length,
    folder: "snapshot_images",
  });

  return up.url;
};

// const getAllOrders = async (req, res) => {
//   try {
//     const orders = await OrderCustomProduct.find().sort({ purchase_date: -1 });
//     res.json(orders);
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Failed to retrieve orders", error: error.message });
//   }
// };

const getOrderById = async (req, res) => {
  try {
    const order = await OrderCustomProduct.findById(req.params.id)
      .populate("forced_vendor_id", "name") // Lấy thêm tên Hãng
      .populate("items.manual_vendor_cost_center_id")
      .lean(); // Lấy đầy đủ Size, Color, BaseCost của biến thể

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    res.json(order);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to retrieve order", error: error.message });
  }
};

const getFrontendOrders = async (req, res) => {
  try {
    const {
      page = 1,
      perPage = 10,
      from,
      to,
      status,
      statuses,
      isNoCostCenter,
      financialStatus,
      sevenDayAlert,
      platform,
      search,
      userNull,
      noPsd,
      shippingType,
      shopName,
      openCase,
      teamId,
      sellerId,
      invalidAddress,
      vendor,
      vendors,
      sortBy,
      sortOrder,

      // ✅ logs
      includeLogs = "true",
      logLimit = 10,
    } = req.query;

    // ===== RBAC =====
    const { role = "", userId = "" } = req.user || {};
    const roles = {
      isAdmin: /^admin$/i.test(role),
      isSeller: /^seller$/i.test(role),
      isProduction: /^production$/i.test(role),
      isDesignLeader: /^design[-_\s]?leader$/i.test(role),
    };

    if (!Object.values(roles).some(Boolean)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const ids = validateIds({ teamId, sellerId, userId });
    if (ids.error) {
      return res.status(400).json({ message: ids.error });
    }

    const initialMatch = buildInitialMatch(ids, roles, userId, userNull);

    // ✅ IMPORTANT: listing là populate -> KHÔNG filter noPsd bằng items.listing.psd.status trong Mongo
    const filters = buildFilters({
      status,
      statuses,
      search,
      openCase,
      from,
      to,
      isNoCostCenter,
      financialStatus,
      sevenDayAlert,
      platform,
      noPsd: null, // ✅ disable trong buildFilters
      shippingType,
    });

    // ===== Selected vendor filter =====
    const selectedVendors = vendor || vendors;
    if (selectedVendors) {
      const selectedVendorFilter =
        await buildSelectedVendorsFilter(selectedVendors);
      if (selectedVendorFilter.error) {
        return res.status(400).json({ message: selectedVendorFilter.error });
      }
      if (selectedVendorFilter.filter) {
        filters.push(selectedVendorFilter.filter);
      }
    }

    // ===== Production vendor filter =====
    if (roles.isProduction) {
      const vendorFilter = await buildVendorFilter();
      if (vendorFilter === null) {
        return res.json({
          data: [],
          totalCount: 0,
          totalPages: 1,
          currentPage: 1,
          includeLogs: normalizeBool(includeLogs),
          logLimit: normalizeBool(includeLogs)
            ? Math.max(1, Math.min(parseInt(logLimit, 10) || 5, 50))
            : 0,
        });
      }
      filters.push(vendorFilter);
    }

    // ===== No Cost Center (giữ rule bạn đang dùng) =====
    if (normalizeBool(isNoCostCenter)) {
      filters.push({
        $or: [
          { base_cost: { $exists: false } },
          { base_cost: null },
          { base_cost: 0 },
        ],
      });
      filters.push({ status: { $ne: "Cancelled" } });
    }

    // ===== Invalid address =====
    if (normalizeBool(invalidAddress)) {
      filters.push({ "address_validation.isValid": false });
    }

    // ✅ ===== No PSD: filter theo listingId (đúng vì listing được populate) =====
    const wantNoPsd = normalizeBool(noPsd);
    if (wantNoPsd) {
      // ⚠️ Sửa đúng model Listing của bạn tại đây:
      const ListingModel = db.listing; // <-- đổi đúng tên model listing trong project bạn

      if (!ListingModel) {
        return res
          .status(500)
          .json({ message: "Listing model not found in db" });
      }

      const listingIds = await getListingIdsNoPsd(ListingModel);

      // không có listing Unavailable => trả rỗng luôn
      if (!listingIds.length) {
        const pageNum = parseInt(page, 10) || 1;
        return res.json({
          data: [],
          totalCount: 0,
          totalPages: 1,
          currentPage: pageNum,
          includeLogs: normalizeBool(includeLogs),
          logLimit: normalizeBool(includeLogs)
            ? Math.max(1, Math.min(parseInt(logLimit, 10) || 5, 50))
            : 0,
        });
      }

      filters.push({
        items: {
          $elemMatch: {
            listingId: { $in: listingIds },
          },
        },
      });

      // Optional: loại Cancelled
      filters.push({ status: { $ne: "Cancelled" } });
    }

    // ===== Build pipeline =====
    const pipeline = await buildPipeline({
      initialMatch,
      filters,
      userId: userId,
      teamObjectId: ids.teamObjectId,
      sellerObjectId: ids.sellerObjectId,
      shopName,
      roles
    });

    const { orders, totalCount, limitNum } = await executePipeline(
      pipeline,
      page,
      perPage,
      { sortBy, sortOrder }
    );

    const enrichedOrders = await enrichOrdersData(orders);

    // =========================
    // ✅ attach logs
    // =========================
    const wantLogs = normalizeBool(includeLogs);
    const limitLogs = Math.max(1, Math.min(parseInt(logLimit, 10) || 5, 50));

    let ordersWithLogs = enrichedOrders;

    if (wantLogs && Array.isArray(enrichedOrders) && enrichedOrders.length) {
      const orderIds = enrichedOrders.map((o) => o.orderId).filter(Boolean);

      const logs = await OrderHistory.find({ orderId: { $in: orderIds } })
        .sort({ createdAt: -1 })
        .select(
          "orderId action description changes orderItemId userId userName userRole source createdAt"
        )
        .lean();

      const map = new Map();
      for (const lg of logs) {
        const key = String(lg.orderId);
        if (!map.has(key)) map.set(key, []);
        const arr = map.get(key);
        if (arr.length < limitLogs) arr.push(lg);
      }

      ordersWithLogs = enrichedOrders.map((o) => {
        const key = String(o.orderId || "");
        const historyDesc = map.get(key) || []; // mới -> cũ
        const historyAsc = [...historyDesc].reverse(); // cũ -> mới
        return {
          ...o,
          latestLog: historyDesc[0] || null,
          history: historyAsc,
        };
      });
    }
    // =========================

    const pageNum = parseInt(page, 10) || 1;
    const isAll = String(perPage).toLowerCase() === "all";

    return res.json({
      data: ordersWithLogs,
      totalCount,
      totalPages: isAll ? 1 : Math.ceil(totalCount / limitNum),
      currentPage: pageNum,
      includeLogs: wantLogs,
      logLimit: wantLogs ? limitLogs : 0,
    });
  } catch (error) {
    console.error("Get orders error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

const getOrderStatistics = async (req, res) => {
  try {
    const {
      from,
      to,
      search,
      platform,
      userNull,
      noPsd, // nếu FE filter theo noPsd=true
      shippingType,
      shopName,
      teamId,
      openCase,
      vendor,
      vendors,
    } = req.query;

    // ===== RBAC =====
    const { role = "", userId = "" } = req.user || {};
    const roles = {
      isAdmin: /^admin$/i.test(role),
      isSeller: /^seller$/i.test(role),
      isProduction: /^production$/i.test(role),
      isDesignLeader: /^design[-_\s]?leader$/i.test(role),
    };
    if (!Object.values(roles).some(Boolean)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // ===== VALIDATE IDS & BASE MATCH =====
    const ids = validateIds({ teamId, sellerId: null, userId });
    if (ids.error) return res.status(400).json({ message: ids.error });

    const baseMatch = buildInitialMatch(ids, roles, userId, userNull);

    // ✅ buildFilters KHÔNG xử lý noPsd trực tiếp (vì listing là populate)
    const filters = buildFilters({
      statuses: null,
      search,
      openCase,
      from,
      to,
      isNoCostCenter: null,
      financialStatus: null,
      sevenDayAlert: null,
      platform,
      noPsd: null, // ✅ disable
      shippingType,
    });

    // ===== Selected vendor filter =====
    const selectedVendors = vendor || vendors;
    if (selectedVendors) {
      const selectedVendorFilter =
        await buildSelectedVendorsFilter(selectedVendors);
      if (selectedVendorFilter.error) {
        return res.status(400).json({ message: selectedVendorFilter.error });
      }
      if (selectedVendorFilter.filter) {
        filters.push(selectedVendorFilter.filter);
      }
    }

    // ===== TEAM FILTER (leader) =====
    const Team = db.Team;
    const User = db.user;
    let team = null;
    // Bỏ qua ép giới hạn theo team nếu là Admin (trừ phi admin tự truyền ids.teamObjectId)
    if (!roles.isAdmin) {
      team = await Team.findOne({ leaderId: userId }).select("_id").lean();
    }
    if (team && baseMatch.sellerId) delete baseMatch.sellerId;

    if (ids.teamObjectId || team) {
      const tId = ids.teamObjectId || team._id;
      const members = await User.find({ team_id: tId }).select("_id").lean();
      filters.push({ sellerId: { $in: members.map((u) => u._id) } });
    }

    // ===== PRODUCTION VENDOR (LNG Group) =====
    if (roles.isProduction) {
      const vendorFilter = await buildVendorFilter();
      if (!vendorFilter) {
        return res.json({
          all: 0,
          new: 0,
          noCostCenter: 0,
          noCostCenterByStatus: {
            new: 0,
            fulfilled: 0,
            shipped: 0,
          },
          noPsd: 0,
          paymentPending: 0,
          fulfilled: 0,
          shipped: 0,
          cancelled: 0,
          refund: 0,
          openCase: 0,
          invalidAddress: 0,
        });
      }
      filters.push(vendorFilter);
    }

    // ===== SHOP FILTER =====
    if (shopName) {
      const shop = await db.shop.findOne({ name: shopName }).lean();
      if (shop?._id) filters.push({ shopId: shop._id });
    }

    // ✅ chuẩn bị listingIds cho facet noPsd
    const ListingModel = db.listing; // <-- đổi đúng model listing của bạn
    if (!ListingModel) {
      return res.status(500).json({ message: "Listing model not found in db" });
    }
    const listingIdsNoPsd = await getListingIdsNoPsd(ListingModel);

    // ===== nếu FE đang filter noPsd=true: áp dụng filter vào dataset thống kê =====
    const wantNoPsdFilter = normalizeBool(noPsd);
    if (wantNoPsdFilter) {
      if (!listingIdsNoPsd.length) {
        return res.json({
          all: 0,
          new: 0,
          noCostCenter: 0,
          noCostCenterByStatus: {
            new: 0,
            fulfilled: 0,
            shipped: 0,
          },
          noPsd: 0,
          paymentPending: 0,
          fulfilled: 0,
          shipped: 0,
          cancelled: 0,
          refund: 0,
          openCase: 0,
          invalidAddress: 0,
        });
      }
      filters.push({
        items: { $elemMatch: { listingId: { $in: listingIdsNoPsd } } },
      });
      filters.push({ status: { $ne: "Cancelled" } });
    }

    // ===== Gom match =====
    const match = { ...baseMatch };
    if (filters.length) match.$and = filters;

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
    const NO_COST_CENTER_NEW = {
      $and: [...NO_COST_CENTER.$and, { status: "New" }],
    };
    const NO_COST_CENTER_FULFILLED = {
      $and: [...NO_COST_CENTER.$and, { status: "Fulfilled" }],
    };
    const NO_COST_CENTER_SHIPPED = {
      $and: [...NO_COST_CENTER.$and, { status: "Shipped" }],
    };

    // ✅ matcher cho facet "noPsd" (không phụ thuộc populate)
    const NO_PSD_MATCH =
      listingIdsNoPsd.length === 0
        ? { _id: null } // luôn 0
        : {
          $and: [
            {
              items: { $elemMatch: { listingId: { $in: listingIdsNoPsd } } },
            },
            { status: { $ne: "Cancelled" } },
          ],
        };

    const [stat] = await OrderCustomProduct.aggregate([
      { $match: match },
      {
        $facet: {
          all: [{ $count: "c" }],
          new: [{ $match: { status: "New" } }, { $count: "c" }],
          noCostCenter: [{ $match: NO_COST_CENTER }, { $count: "c" }],
          noCostCenterNew: [{ $match: NO_COST_CENTER_NEW }, { $count: "c" }],
          noCostCenterFulfilled: [{ $match: NO_COST_CENTER_FULFILLED }, { $count: "c" }],
          noCostCenterShipped: [{ $match: NO_COST_CENTER_SHIPPED }, { $count: "c" }],

          // ✅ NEW: No PSD count
          noPsd: [{ $match: NO_PSD_MATCH }, { $count: "c" }],

          paymentPending: [
            { $match: { financialStatus: "Pending" } },
            { $count: "c" },
          ],
          fulfilled: [{ $match: { status: "Fulfilled" } }, { $count: "c" }],
          shipped: [{ $match: { status: "Shipped" } }, { $count: "c" }],
          cancelled: [{ $match: { status: "Cancelled" } }, { $count: "c" }],
          refund: [{ $match: { status: "Refund" } }, { $count: "c" }],
          openCase: [
            { $match: { case: { $exists: true, $ne: [] } } },
            { $count: "c" },
          ],
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
          noCostCenter: {
            $ifNull: [{ $arrayElemAt: ["$noCostCenter.c", 0] }, 0],
          },
          noCostCenterByStatus: {
            new: { $ifNull: [{ $arrayElemAt: ["$noCostCenterNew.c", 0] }, 0] },
            fulfilled: { $ifNull: [{ $arrayElemAt: ["$noCostCenterFulfilled.c", 0] }, 0] },
            shipped: { $ifNull: [{ $arrayElemAt: ["$noCostCenterShipped.c", 0] }, 0] },
          },
          noPsd: { $ifNull: [{ $arrayElemAt: ["$noPsd.c", 0] }, 0] },

          paymentPending: {
            $ifNull: [{ $arrayElemAt: ["$paymentPending.c", 0] }, 0],
          },
          fulfilled: { $ifNull: [{ $arrayElemAt: ["$fulfilled.c", 0] }, 0] },
          shipped: { $ifNull: [{ $arrayElemAt: ["$shipped.c", 0] }, 0] },
          cancelled: { $ifNull: [{ $arrayElemAt: ["$cancelled.c", 0] }, 0] },
          refund: { $ifNull: [{ $arrayElemAt: ["$refund.c", 0] }, 0] },
          openCase: { $ifNull: [{ $arrayElemAt: ["$openCase.c", 0] }, 0] },
          invalidAddress: {
            $ifNull: [{ $arrayElemAt: ["$invalidAddress.c", 0] }, 0],
          },
        },
      },
    ]);

    return res.json(
      stat || {
        all: 0,
        new: 0,
        noCostCenter: 0,
        noCostCenterByStatus: {
          new: 0,
          fulfilled: 0,
          shipped: 0,
        },
        noPsd: 0,
        paymentPending: 0,
        fulfilled: 0,
        shipped: 0,
        cancelled: 0,
        refund: 0,
        openCase: 0,
        invalidAddress: 0,
      }
    );
  } catch (err) {
    console.error("❌ getOrderStatistics error:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

const updateOrderStatus = async (req, res) => {
  try {
    const { orderId, status } = req.body;
    const allowedStatuses = ["New", "Fulfilled", "Shipping", "Shipped", "Canceled", "Cancelled"];

    if (!orderId || !status) {
      return res.status(400).json({ message: "Missing orderId or status" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const oldStatus = order.status;

    // Không đổi gì → không log
    if (oldStatus === status) {
      return res.status(200).json({
        message: "No change",
        orderId,
        newStatus: status,
      });
    }

    order.status = status;
    await order.save();

    // ===== LOGGER =====
    await logOrderHistory({
      orderDoc: order,
      action: "UPDATE_STATUS",
      description: `Order status changed from ${oldStatus} to ${status}`,
      changes: [
        {
          field: "status",
          from: oldStatus,
          to: status,
        },
      ],
      user: req.user,
      context: {
        source: "PORTAL",
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      },
    });
    await logOrderLifecycleEvent(buildOrderLifecyclePayload({
      order,
      req,
      fallbackPlatform: "amazon",
      stage: "ORDER_STATUS",
      eventType: "ORDER_STATUS_CHANGED",
      status: "success",
      message: `Order status changed from ${oldStatus} to ${status}`,
      metadata: { fromStatus: oldStatus, toStatus: status },
    }));
    // ==================

    return res.status(200).json({
      message: "Order status updated successfully",
      orderId,
      oldStatus,
      newStatus: status,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to update order status",
      error: error.message,
    });
  }
};

function normalizeExcelHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function extractOrderIdsFromWorkbook(workbook) {
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  const ids = [];

  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    const orderIdHeader = headers.find((header) =>
      ["orderid", "amazonorderid", "amazonorder"].includes(
        normalizeExcelHeader(header)
      )
    );

    if (orderIdHeader) {
      for (const row of rows) {
        const value = String(row[orderIdHeader] || "").trim();
        if (value) ids.push(value);
      }
    }
  }

  if (ids.length === 0) {
    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: false,
    });

    for (const row of matrix) {
      const value = String(row?.[0] || "").trim();
      if (!value) continue;
      if (["orderid", "order id", "order_id"].includes(value.toLowerCase())) {
        continue;
      }
      ids.push(value);
    }
  }

  return [...new Set(ids)];
}

const bulkCancelOrdersFromExcel = async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!req.file) {
      return res.status(400).json({ message: "Missing Excel file" });
    }

    const workbook = XLSX.readFile(filePath, { type: "file" });
    const orderIds = extractOrderIdsFromWorkbook(workbook);
    const dryRun =
      String(req.body?.dryRun ?? req.query?.dryRun ?? "false").toLowerCase() ===
      "true";

    if (orderIds.length === 0) {
      return res.status(400).json({
        message:
          "No orderId found. Use a column named orderId/orderID, or put order IDs in the first column.",
      });
    }

    const orders = await OrderCustomProduct.find(
      { orderId: { $in: orderIds } },
      { _id: 1, orderId: 1, status: 1, scale_overall_status: 1 }
    ).lean();

    const foundOrderIds = new Set(orders.map((order) => order.orderId));
    const notFound = orderIds.filter((orderId) => !foundOrderIds.has(orderId));
    const alreadyCancelled = orders
      .filter(
        (order) =>
          order.status === "Cancelled" &&
          order.scale_overall_status === "Cancelled"
      )
      .map((order) => order.orderId);
    const toCancel = orders.filter(
      (order) =>
        order.status !== "Cancelled" ||
        order.scale_overall_status !== "Cancelled"
    );

    if (!dryRun && toCancel.length > 0) {
      const now = new Date();
      const cancelIds = toCancel.map((order) => order.orderId);

      await OrderCustomProduct.updateMany(
        { orderId: { $in: cancelIds } },
        {
          $set: {
            status: "Cancelled",
            scale_overall_status: "Cancelled",
            "items.$[].scale_status": "Cancelled",
            "items.$[].tracking_info.status": "Cancelled",
            "items.$[].tracking_info.updated_at": now,
          },
        }
      );

      const userId =
        req.user?._id ||
        req.user?.id ||
        req.user?.userId ||
        req.user?.uid ||
        null;
      const userName =
        req.user?.name ||
        req.user?.fullName ||
        req.user?.username ||
        req.user?.email ||
        null;
      const userRole =
        req.user?.role || req.user?.userRole || req.user?.type || null;

      await OrderHistory.insertMany(
        toCancel.map((order) => ({
          order: order._id,
          orderId: order.orderId,
          action: "UPDATE_STATUS",
          description: "Order cancelled from Excel upload",
          changes: [
            { field: "status", from: order.status, to: "Cancelled" },
            {
              field: "scale_overall_status",
              from: order.scale_overall_status,
              to: "Cancelled",
            },
          ],
          userId,
          userName,
          userRole,
          source: "PORTAL",
          ip: req.ip || null,
          userAgent: req.headers["user-agent"] || null,
        })),
        { ordered: false }
      );
    }

    return res.status(200).json({
      message: dryRun ? "Bulk cancel dry run completed" : "Bulk cancel completed",
      dryRun,
      totalInFile: orderIds.length,
      matched: orders.length,
      cancelled: toCancel.length,
      alreadyCancelled: alreadyCancelled.length,
      notFound: notFound.length,
      details: {
        cancelledOrderIds: toCancel.map((order) => order.orderId),
        alreadyCancelledOrderIds: alreadyCancelled,
        notFoundOrderIds: notFound,
      },
    });
  } catch (error) {
    console.error("bulkCancelOrdersFromExcel error:", error);
    return res.status(500).json({
      message: "Failed to bulk cancel orders",
      error: error.message,
    });
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) { }
    }
  }
};

const updateShippingType = async (req, res) => {
  try {
    const { orderId, shipping_type } = req.body;
    const allowedShippingType = [
      "Second Day",
      "Ground",
      "Overnight",
      "Economy",
      "Standard",
    ];

    if (!orderId || !shipping_type) {
      return res
        .status(400)
        .json({ message: "Missing orderId or shipping type" });
    }

    if (!allowedShippingType.includes(shipping_type)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    order.shipping_type = shipping_type;
    await order.save();

    res.status(200).json({
      message: "Order shipping type updated successfully",
      orderId,
      newShippingType: shipping_type,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update order shipping type",
      error: error.message,
    });
  }
};

const updateBaseCost = async (req, res) => {
  try {
    const { orderId, base_cost } = req.body;

    if (!orderId || base_cost === undefined || base_cost === null) {
      return res.status(400).json({ message: "Missing orderId or base cost" });
    }

    if (typeof base_cost !== "number" || base_cost <= 0) {
      return res
        .status(400)
        .json({ message: "Base Cost must be a positive number" });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const oldBaseCost = Number(order.base_cost || 0);
    order.base_cost = base_cost;
    await order.save();

    if (oldBaseCost !== Number(base_cost)) {
      await logOrderHistory({
        orderDoc: order,
        action: "UPDATE_BASE_COST",
        description: "Order base cost manually updated",
        changes: [
          {
            field: "base_cost",
            from: oldBaseCost,
            to: base_cost,
          },
        ],
        user: req.user,
        context: {
          source: "PORTAL",
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
      });

      await logOrderLifecycleEvent(buildOrderLifecyclePayload({
        order,
        req,
        fallbackPlatform: "amazon",
        stage: "BASE_COST",
        eventType: "ORDER_BASE_COST_UPDATED",
        status: "success",
        message: "Order base cost manually updated",
        metadata: {
          oldBaseCost,
          newBaseCost: base_cost,
        },
      }));
    }

    res.status(200).json({
      message: "Order base cost updated successfully",
      orderId,
      newBaseCost: base_cost,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update order base cost",
      error: error.message,
    });
  }
};

const resetBaseCost = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: "Missing orderId" });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    const oldBaseCost = Number(order.base_cost || 0);
    const oldShippingGroups = Array.isArray(order.base_cost_shipping_groups)
      ? order.base_cost_shipping_groups
      : [];
    const oldComputedAt = order.base_cost_computed_at || null;
    const itemsWithCostBreakdown = Array.isArray(order.items)
      ? order.items.filter((item) => item?.cost_breakdown != null).length
      : 0;

    order.base_cost = 0;
    order.base_cost_shipping_groups = [];
    order.base_cost_computed_at = null;

    if (Array.isArray(order.items)) {
      for (const item of order.items) {
        item.cost_breakdown = undefined;
      }
    }

    await order.save();

    const changes = [];
    if (oldBaseCost !== 0) {
      changes.push({
        field: "base_cost",
        from: oldBaseCost,
        to: 0,
      });
    }

    if (oldShippingGroups.length > 0) {
      changes.push({
        field: "base_cost_shipping_groups",
        from: oldShippingGroups,
        to: [],
      });
    }

    if (oldComputedAt) {
      changes.push({
        field: "base_cost_computed_at",
        from: oldComputedAt,
        to: null,
      });
    }

    if (itemsWithCostBreakdown > 0) {
      changes.push({
        field: "items.cost_breakdown",
        from: `${itemsWithCostBreakdown} item(s) had cost breakdown`,
        to: "removed",
      });
    }

    if (changes.length > 0) {
      await logOrderHistory({
        orderDoc: order,
        action: "UPDATE_BASE_COST",
        description: "Order base cost reset to 0 and item cost breakdown removed",
        changes,
        user: req.user,
        context: {
          source: "PORTAL",
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
      });
    }

    return res.status(200).json({
      message: "Order base cost reset successfully",
      orderId,
      base_cost: 0,
      removedCostBreakdownCount: itemsWithCostBreakdown,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to reset order base cost",
      error: error.message,
    });
  }
};

const updateCustomerInfo = async (req, res) => {
  try {
    const { orderId, customer_infor } = req.body;

    if (!orderId || !customer_infor || typeof customer_infor !== "object") {
      return res
        .status(400)
        .json({ message: "Missing or invalid orderId or customer_infor" });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Nếu chưa có field customer_infor, khởi tạo object
    if (!order.customer_infor) order.customer_infor = {};

    // Chỉ cập nhật các trường được truyền lên
    Object.keys(customer_infor).forEach((key) => {
      order.customer_infor[key] = customer_infor[key];
    });

    const address = order.customer_infor;
    if (!address) {
      return res.status(400).json({
        message: "Order does not have customer_infor to validate",
        orderId,
      });
    }
    const validationResult = await validateAddressWithSmarty(address);
    order.address_validation = validationResult;
    await order.save();

    res
      .status(200)
      .json({ message: "Customer info updated successfully", orderId });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update customer info",
      error: error.message,
    });
  }
};

const openCaseInOrder = async (req, res) => {
  try {
    const { orderId, caseIds } = req.body;

    if (!orderId || !Array.isArray(caseIds)) {
      return res
        .status(400)
        .json({ message: "Missing orderId or caseIds (should be an array)" });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Khởi tạo nếu chưa có
    if (!Array.isArray(order.case)) {
      order.case = [];
    }

    const oldCases = [...order.case.map((id) => String(id))];

    // Lọc bỏ các case đã có
    const newCaseIds = caseIds.filter((id) => !oldCases.includes(String(id)));

    // Không có case mới → không cần log
    if (newCaseIds.length === 0) {
      return res.status(200).json({
        message: "No new case added",
        orderId,
        case: order.case,
      });
    }

    // Append case mới
    order.case.push(...newCaseIds);
    await order.save();

    // ===== LOGGER =====
    await logOrderHistory({
      orderDoc: order,
      action: "OPEN_CASE",
      description: `Added ${newCaseIds.length} case(s) to order`,
      changes: [
        {
          field: "case",
          from: oldCases,
          to: order.case.map((id) => String(id)),
        },
      ],
      user: req.user,
      context: {
        source: "PORTAL",
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      },
    });
    // ==================

    res.status(200).json({
      message: "Case field appended successfully",
      orderId,
      case: order.case,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to append case field",
      error: error.message,
    });
  }
};

const removeCaseFromOrder = async (req, res) => {
  try {
    const { orderId, caseIds } = req.body;

    if (!orderId || !Array.isArray(caseIds)) {
      return res
        .status(400)
        .json({ message: "Missing orderId or caseIds (should be an array)" });
    }

    // Normalize + unique + validate
    const normalizedCaseIds = [...new Set(caseIds.map((id) => String(id)))];

    const invalidIds = normalizedCaseIds.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id)
    );
    if (invalidIds.length > 0) {
      return res.status(400).json({
        message: "Invalid caseId(s)",
        invalidIds,
      });
    }

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (!Array.isArray(order.case)) {
      order.case = [];
    }

    // Snapshot before
    const oldCases = order.case.map((id) => String(id));

    // Remove
    const newCases = oldCases.filter((id) => !normalizedCaseIds.includes(id));

    // Không có thay đổi → không log
    if (newCases.length === oldCases.length) {
      return res.status(200).json({
        message: "No case removed",
        orderId,
        case: order.case,
      });
    }

    order.case = newCases;
    await order.save();

    // ===== LOGGER =====
    await logOrderHistory({
      orderDoc: order,
      action: "REMOVE_CASE",
      description: `Removed ${oldCases.length - newCases.length
        } case(s) from order`,
      changes: [
        {
          field: "case",
          from: oldCases,
          to: newCases,
        },
      ],
      user: req.user,
      context: {
        source: "PORTAL",
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      },
    });
    // ==================

    return res.status(200).json({
      message: "Case(s) removed successfully",
      orderId,
      case: order.case,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to remove case(s)",
      error: error.message,
    });
  }
};
const updateBaseImageUrl = async (req, res) => {
  try {
    const { orderId, orderItemId, imageUrl } = req.body;

    // Validate input
    if (!orderId || !orderItemId || !imageUrl) {
      return res
        .status(400)
        .json({ message: "Missing orderId, orderItemId, or imageUrl" });
    }

    // Validate imageUrl format (basic URL validation)
    const urlRegex = /^(https?:\/\/[^\s$.?#].[^\s]*)$/;
    if (!urlRegex.test(imageUrl)) {
      return res.status(400).json({ message: "Invalid imageUrl format" });
    }

    // Find the order
    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Find the item within the order
    const item = order.items.find((i) => i.orderItemId === orderItemId);
    if (!item) {
      return res
        .status(404)
        .json({ message: "OrderItem ID not found in Order" });
    }

    // Update baseImage.imageUrl
    if (!item.baseImage) {
      item.baseImage = {};
    }
    item.baseImage.imageUrl = imageUrl;

    // Save the updated order
    await order.save();

    res.status(200).json({
      message: "Base image URL updated successfully",
      orderId,
      orderItemId,
      newImageUrl: imageUrl,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update base image URL",
      error: error.message,
    });
  }
};

// ================== BASE COST HELPERS & APIS ==================
function parseConfigCodeFromSKU(sku = "") {
  const parts = String(sku)
    .split("-")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}

function toArray(val) {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  return [val];
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function pickValueByKeys(labelValueMap, keys = []) {
  for (const k of toArray(keys)) {
    const v = labelValueMap.get(normalize(k));
    if (v != null && v !== "") return v;
  }
  return "";
}

// Lấy map label->value từ version3 (ưu tiên) rồi fallback customizationData
function extractLabelValueMapFromItem(item) {
  const map = new Map();
  const surfacesV3 = item?.version3Data?.customizationInfo?.surfaces || [];
  for (const sf of surfacesV3) {
    for (const area of sf?.areas || []) {
      const label = area?.label || area?.name || "";
      const value = area?.optionValue ?? area?.text ?? "";
      if (label) map.set(normalize(label), String(value));
    }
  }
  if (map.size === 0) {
    const opts =
      item?.customizationData?.children?.[0]?.children?.[0]?.children || [];
    for (const opt of opts) {
      const label = opt?.label || opt?.name || "";
      let value = "";
      if (opt?.optionSelection)
        value = opt.optionSelection?.label || opt.optionSelection?.name || "";
      else if (typeof opt?.inputValue === "string") value = opt.inputValue;
      else if (opt?.displayValue) value = opt.displayValue;
      if (label) map.set(normalize(label), String(value || ""));
    }
  }
  return map;
}

/**
 * Mapping-only:
 * - match_type: 'equals' | 'contains' | 'regex' | 'regex_replace'
 * - priority: số nhỏ ưu tiên trước
 */
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

// Chọn đúng ConfigCostCenter theo product type
async function selectConfigByProductType(configCode, labelValueMap) {
  const cfgCandidates = await ConfigCostCenter.find({
    config_code: configCode,
    is_deleted: { $in: [false, null] },
  })
    .populate("product_for_seller")
    .lean();

  if (!cfgCandidates.length)
    return { cfg: null, reason: "No config cost center found by config_code" };

  for (const c of cfgCandidates) {
    const typeValRaw = pickValueByKeys(
      labelValueMap,
      c.customize_product_type_key || []
    );
    const typeVal = normalize(typeValRaw);
    const sellerName = normalize(c?.product_for_seller?.name || "");
    if (typeVal && sellerName && typeVal === sellerName) {
      return {
        cfg: c,
        productTypeValue: typeValRaw,
        matchedBy: "product_type_exact",
      };
    }
  }

  if (cfgCandidates.length === 1) {
    const only = cfgCandidates[0];
    const typeValRaw = pickValueByKeys(
      labelValueMap,
      only.customize_product_type_key || []
    );
    return {
      cfg: only,
      productTypeValue: typeValRaw,
      matchedBy: "single_candidate_fallback",
    };
  }

  return {
    cfg: null,
    reason: "Multiple configs; cannot determine by product type key/value",
  };
}

// So khớp strict size/color
function findBestCostCenter(
  candidates,
  sizeValue,
  colorValue,
  { strict = true } = {}
) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .trim();
  const sizeN = norm(sizeValue);
  const colorN = norm(colorValue);
  const hit = candidates.find(
    (c) => norm(c.vendor_size) === sizeN && norm(c.vendor_color) === colorN
  );
  if (hit) return hit;
  if (strict) return null;
  return null;
}

/** Dry-run match cho 1 pfItem */
async function tryMatchVendorProduct(pfItem, sizeValue, colorValue) {
  const vendorProductId = pfItem?.vendor_product;
  if (!vendorProductId) return null;

  const candidates = await VendorCostCenter.find({
    vendor_product: vendorProductId,
    status: { $in: ["Active", null] },
  })
    .select(
      "vendor_size vendor_color standard_size standard_color base_cost sku international.economy international.additional additional_costs"
    )
    .lean();

  if (!candidates?.length) return null;
  return (
    findBestCostCenter(candidates, sizeValue, colorValue, { strict: true }) ||
    null
  );
}

/** Set<vendorId> có thể fulfill item */
async function listCandidateVendors(pfItems = [], sizeValue, colorValue) {
  const out = new Set();
  for (const it of pfItems) {
    const vendorProductId = it?.vendor_product;
    if (!vendorProductId) continue;

    const matched = await tryMatchVendorProduct(it, sizeValue, colorValue);
    if (!matched) continue;

    const vendorId = String(
      it?.vendor_id ||
      it?.vendor?._id ||
      (await getVendorIdByVendorProductId(vendorProductId)) ||
      ""
    );
    if (vendorId) out.add(vendorId);
  }
  return out;
}

/** Intersection vendor phủ hết order */
function choosePreferredVendorId(candidateSetsPerItem) {
  if (!candidateSetsPerItem.length) return null;
  let inter = new Set(candidateSetsPerItem[0]);
  for (let i = 1; i < candidateSetsPerItem.length; i++) {
    const cur = candidateSetsPerItem[i];
    inter = new Set([...inter].filter((v) => cur.has(v)));
    if (inter.size === 0) break;
  }
  return inter.size ? [...inter][0] : null;
}

/**
 * Chọn VendorProduct tốt nhất từ pfItems cho 1 item.
 * - Ưu tiên pfItem status = active (sau đó mới tất cả)
 * - Nếu có forcedVendorId thì CHỈ xét các pfItems thuộc vendor đó.
 * - Luôn cố lấy vendorId thật từ VendorProduct khi pfItem không có.
 */
async function selectBestVendorProduct(
  pfItems,
  sizeValue,
  colorValue,
  opts = {}
) {
  const { forcedVendorId = null, strictForcedVendor = true } = opts;

  if (!Array.isArray(pfItems) || pfItems.length === 0) {
    return { success: false, reason: "No pfItems provided", checkedItems: [] };
  }

  // Chuẩn hóa danh sách theo active -> order
  const byOrder = (a, b) => (a.order || 999) - (b.order || 999);
  const actives = pfItems
    .filter((it) => String(it.status || "").toLowerCase() === "active")
    .sort(byOrder);
  let itemsToCheck = actives.length ? actives : [...pfItems].sort(byOrder);

  // Map sẵn vendorId cho từng pfItem
  const resolved = [];
  for (const it of itemsToCheck) {
    const vpId = it?.vendor_product;
    if (!vpId) continue;
    const vId = String(
      it?.vendor_id ||
      it?.vendor?._id ||
      (await getVendorIdByVendorProductId(vpId)) ||
      ""
    );
    resolved.push({ ...it, __vendorId: vId, __vendorProductId: vpId });
  }

  // Nếu ép vendor: chỉ giữ lại các pfItem cùng vendor
  if (forcedVendorId) {
    const filtered = resolved.filter(
      (x) => x.__vendorId && String(x.__vendorId) === String(forcedVendorId)
    );
    if (filtered.length === 0) {
      // Không có pfItem thuộc vendor bị ép
      return {
        success: false,
        reason: `No pfItems under forced vendor ${forcedVendorId}`,
        forcedVendorId,
      };
    }
    itemsToCheck = filtered;
  } else {
    itemsToCheck = resolved;
  }

  // Tìm cost center khớp size/color
  for (const item of itemsToCheck) {
    const vendorProductId = item.__vendorProductId;
    const vendorId = item.__vendorId;

    const candidates = await VendorCostCenter.find({
      vendor_product: vendorProductId,
      status: { $in: ["Active", "active", null] },
    })
      .select(
        "vendor_size vendor_color standard_size standard_color base_cost sku international.economy international.additional additional_costs"
      )
      .lean();

    if (!candidates?.length) continue;

    // strict trước, không được thì thử non-strict
    let matched = findBestCostCenter(candidates, sizeValue, colorValue, {
      strict: true,
    });
    if (!matched)
      matched = findBestCostCenter(candidates, sizeValue, colorValue, {
        strict: false,
      });

    if (matched && Number(matched?.base_cost || 0) > 0) {
      return {
        success: true,
        vendorProductId,
        matched,
        selectedOrder: item.order || 999,
        itemDisplayName: item.display_name || "Unknown",
        vendorId,
      };
    }
  }

  // Không tìm thấy phù hợp
  return {
    success: false,
    reason:
      forcedVendorId && strictForcedVendor
        ? `No matching cost center under forced vendor ${forcedVendorId}`
        : "No matching vendor product with valid cost center found",
    forcedVendorId: forcedVendorId || undefined,
    checkedItems: itemsToCheck.map((it) => ({
      order: it.order,
      display_name: it.display_name,
      vendor_product: String(it.__vendorProductId || ""),
      vendor_id: String(it.__vendorId || ""),
    })),
  };
}

// ======== NEW: Build rank cho vendor dựa trên pfItems.order (số nhỏ ưu tiên trước) ========
async function buildVendorRank(preItems) {
  const rank = new Map(); // vendorId -> minOrder
  for (const pre of preItems) {
    // Đảm bảo mỗi pfItem có __vendorId giống trong selectBestVendorProduct
    const resolved = [];
    for (const it of toArray(pre.pfItems)) {
      const vpId = it?.vendor_product;
      if (!vpId) continue;
      const vId = String(
        it?.vendor_id ||
        it?.vendor?._id ||
        (await getVendorIdByVendorProductId(vpId)) ||
        ""
      );
      if (!vId) continue;
      resolved.push({ ...it, __vendorId: vId, __vendorProductId: vpId });
    }
    // Cập nhật rank theo order nhỏ nhất
    for (const it of resolved) {
      const o = it.order ?? 999;
      const key = String(it.__vendorId);
      rank.set(key, Math.min(rank.get(key) ?? 999, o));
    }
  }
  return rank;
}

// ======== NEW: Chọn preferred vendor ổn định theo giao & vendor-rank ========
function choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) {
  if (!candidateSetsPerItem.length) return null;

  // Giao tất cả set
  let inter = new Set(candidateSetsPerItem[0]);
  for (let i = 1; i < candidateSetsPerItem.length; i++) {
    const cur = candidateSetsPerItem[i];
    inter = new Set([...inter].filter((v) => cur.has(v)));
    if (inter.size === 0) break;
  }
  if (!inter.size) return null;

  // Chọn vendor có rank nhỏ nhất (ưu tiên pfItem.order thấp nhất)
  let best = null;
  let bestRank = Infinity;
  for (const vId of inter) {
    const r = vendorRank.get(String(vId)) ?? 999;
    if (r < bestRank || (r === bestRank && String(vId) < String(best))) {
      best = vId;
      bestRank = r;
    }
  }
  return best;
}

// ================== HELPER: Lấy phí ship theo shipping_type (với nhiều nhánh fallback & normalize) ==================
async function resolveShippingRates({
  matched,
  shippingType,
  vendorProductId,
  sizeValue,
  colorValue,
}) {
  const type = String(shippingType || "").toLowerCase();

  // Chuẩn hoá
  const norm = (v) => String(v || "").trim();
  const up = (v) => norm(v).toUpperCase();

  const sizeCand = Array.from(
    new Set([norm(sizeValue), up(sizeValue)].filter(Boolean))
  );
  const colorCand = Array.from(
    new Set([norm(colorValue), up(colorValue)].filter(Boolean))
  );

  // Pick từ doc (matched hoặc doc DB)
  const pickFromDoc = (
    doc,
    preferProfile /* 'priority' | 'international' */
  ) => {
    if (!doc) return null;

    const hasPriority =
      doc.priority &&
      (doc.priority.economy != null || doc.priority.additional != null);
    const hasIntl =
      doc.international &&
      (doc.international.economy != null ||
        doc.international.additional != null);

    // Ưu tiên profile theo yêu cầu
    if (preferProfile === "priority" && hasPriority) {
      return {
        eco: Number(doc.priority.economy ?? 0),
        add: Number(doc.priority.additional ?? 0),
        profile: "priority",
        source: "doc",
      };
    }
    if (hasIntl) {
      return {
        eco: Number(doc.international.economy ?? 0),
        add: Number(doc.international.additional ?? 0),
        profile: "international",
        source: "doc",
      };
    }
    // Nếu ưu tiên priority nhưng không có, và cũng không có quốc tế → null
    return null;
  };

  // Tra DB theo nhiều nhánh
  async function lookupCostCenter(preferProfile) {
    if (!(typeof VendorCostCenter?.findOne === "function") || !vendorProductId)
      return null;

    // 1) vendor_size/vendor_color (case-insensitive)
    for (const sv of sizeCand.length ? sizeCand : [undefined]) {
      for (const cv of colorCand.length ? colorCand : [undefined]) {
        if (!sv && !cv) continue;
        const doc = await VendorCostCenter.findOne({
          vendor_product: vendorProductId,
          ...(sv ? { vendor_size: new RegExp(`^${sv}$`, "i") } : {}),
          ...(cv ? { vendor_color: new RegExp(`^${cv}$`, "i") } : {}),
        }).lean();
        const picked = pickFromDoc(doc, preferProfile);
        if (picked) return picked;
      }
    }

    // 2) standard_size/standard_color (case-insensitive)
    for (const sv of sizeCand.length ? sizeCand : [undefined]) {
      for (const cv of colorCand.length ? colorCand : [undefined]) {
        if (!sv && !cv) continue;
        const doc = await VendorCostCenter.findOne({
          vendor_product: vendorProductId,
          ...(sv ? { standard_size: new RegExp(`^${sv}$`, "i") } : {}),
          ...(cv ? { standard_color: new RegExp(`^${cv}$`, "i") } : {}),
        }).lean();
        const picked = pickFromDoc(doc, preferProfile);
        if (picked) return picked;
      }
    }

    // 3) Chỉ theo vendor_product (lấy record bất kỳ của SP để có profile mặc định)
    {
      const doc = await VendorCostCenter.findOne({
        vendor_product: vendorProductId,
      }).lean();
      const picked = pickFromDoc(doc, preferProfile);
      if (picked) return picked;
    }

    return null;
  }

  // ===== LOGIC CHÍNH =====
  if (type === "expedited") {
    // 1) matched.priority
    if (
      matched?.priority &&
      (matched.priority.economy != null || matched.priority.additional != null)
    ) {
      return {
        eco: Number(matched.priority.economy ?? 0),
        add: Number(matched.priority.additional ?? 0),
        profile: "priority",
        source: "matched",
      };
    }
    // 2) DB ưu tiên priority, nếu không có thì lấy international
    const dbPicked = await lookupCostCenter("priority");
    if (dbPicked) return dbPicked;

    // 3) Fallback matched.international (đổi profile về international cho đúng thực tế)
    if (
      matched?.international &&
      (matched.international.economy != null ||
        matched.international.additional != null)
    ) {
      return {
        eco: Number(matched.international.economy ?? 0),
        add: Number(matched.international.additional ?? 0),
        profile: "international",
        source: "matched-fallback",
      };
    }
    // 4) Zero
    return { eco: 0, add: 0, profile: "priority", source: "zero" };
  }

  // STANDARD (hoặc loại khác) → INTERNATIONAL
  if (
    matched?.international &&
    (matched.international.economy != null ||
      matched.international.additional != null)
  ) {
    return {
      eco: Number(matched.international.economy ?? 0),
      add: Number(matched.international.additional ?? 0),
      profile: "international",
      source: "matched",
    };
  }
  const dbPicked = await lookupCostCenter("international");
  if (dbPicked) return dbPicked;

  return { eco: 0, add: 0, profile: "international", source: "zero" };
}

async function getVendorIdByVendorProductId(vendorProductId) {
  if (!vendorProductId) return null;
  const vp = await VendorProduct.findById(vendorProductId)
    .select("vendor_id")
    .lean();
  return vp?.vendor_id ? String(vp.vendor_id) : null;
}

function buildBaseCostItemBreakdownMap(items = []) {
  const map = new Map();
  for (const item of items || []) {
    const itemId = item?.orderItemId ? String(item.orderItemId) : null;
    if (!itemId) continue;
    const breakdown = item?.cost_breakdown
      ? JSON.parse(JSON.stringify(item.cost_breakdown))
      : null;
    map.set(itemId, breakdown);
  }
  return map;
}

function buildBaseCostComputeChanges({
  oldBaseCost,
  newBaseCost,
  oldShippingGroups,
  newShippingGroups,
  oldComputedAt,
  newComputedAt,
  oldItemBreakdowns,
  items,
}) {
  const changes = [];

  if (Number(oldBaseCost || 0) !== Number(newBaseCost || 0)) {
    changes.push({
      field: "base_cost",
      from: Number(oldBaseCost || 0),
      to: Number(newBaseCost || 0),
    });
  }

  if (JSON.stringify(oldShippingGroups || []) !== JSON.stringify(newShippingGroups || [])) {
    changes.push({
      field: "base_cost_shipping_groups",
      from: oldShippingGroups || [],
      to: newShippingGroups || [],
    });
  }

  const oldComputedAtValue = oldComputedAt ? new Date(oldComputedAt).toISOString() : null;
  const newComputedAtValue = newComputedAt ? new Date(newComputedAt).toISOString() : null;
  if (oldComputedAtValue !== newComputedAtValue) {
    changes.push({
      field: "base_cost_computed_at",
      from: oldComputedAt || null,
      to: newComputedAt || null,
    });
  }

  let changedItemBreakdowns = 0;
  for (const item of items || []) {
    const itemId = item?.orderItemId ? String(item.orderItemId) : null;
    if (!itemId) continue;

    const before = oldItemBreakdowns.get(itemId) || null;
    const after = item?.cost_breakdown
      ? JSON.parse(JSON.stringify(item.cost_breakdown))
      : null;

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changedItemBreakdowns += 1;
      changes.push({
        field: `items[orderItemId=${itemId}].cost_breakdown`,
        from: before,
        to: after,
      });
    }
  }

  if (changedItemBreakdowns > 0) {
    changes.push({
      field: "items.cost_breakdown_changed_count",
      from: 0,
      to: changedItemBreakdowns,
    });
  }

  return changes;
}

// ================== COMPUTE BASE COST (FULL) ==================
const computeBaseCostForOrder = async (req, res) => {
  let orderId = "";
  let order = null;
  try {
    ({ orderId } = req.body);
    if (!orderId) return res.status(400).json({ message: "Missing orderId" });
    const ignoreManualMapping = req.body?.ignoreManualMapping === true;
    const dryRun = req.body?.dryRun === true;

    order = await OrderCustomProduct.findOne({ orderId }).lean(false);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (!Array.isArray(order.items) || order.items.length === 0) {
      return res.status(400).json({ message: "Order has no items" });
    }
    normalizeImportedItemScaleStatuses(order);

    const oldBaseCost = Number(order.base_cost || 0);
    const oldShippingGroups = Array.isArray(order.base_cost_shipping_groups)
      ? JSON.parse(JSON.stringify(order.base_cost_shipping_groups))
      : [];
    const oldComputedAt = order.base_cost_computed_at || null;
    const oldItemBreakdowns = buildBaseCostItemBreakdownMap(order.items);

    const shippingTypeForOrder = order.shipping_type || "Standard";

    // ✅ helper: sku audit + sku used for cost
    function getSkuForCost(item) {
      const originalSku = (item?.sku || "").trim() || null;
      const mappedSku = (item?.mapped_sku || "").trim() || null;
      const usedSku = mappedSku || originalSku;
      return { originalSku, mappedSku, usedSku };
    }

    // ===== QUERY CACHE (chỉ sống trong 1 lần gọi, tránh re-query DB) =====
    const _cfgCache = new Map();       // configCode → kết quả selectConfigByProductType
    const _optRulesCache = new Map();  // "configCode::key::rawValue" → kết quả mapOptionValue
    const _vpIdCache = new Map();      // vendorProductId → vendorId (string)
    const _vccCache = new Map();       // vendorProductId → VendorCostCenter[] (lean docs)

    // ===== CACHED WRAPPERS =====
    async function cachedSelectConfig(configCode, labelValueMap) {
      if (_cfgCache.has(configCode)) return _cfgCache.get(configCode);
      const result = await selectConfigByProductType(configCode, labelValueMap);
      _cfgCache.set(configCode, result);
      return result;
    }

    async function cachedMapOptionValue({ configCode, key, rawValue }) {
      const cacheKey = `${configCode}::${key}::${rawValue}`;
      if (_optRulesCache.has(cacheKey)) return _optRulesCache.get(cacheKey);
      const result = await mapOptionValue({ configCode, key, rawValue });
      _optRulesCache.set(cacheKey, result);
      return result;
    }

    async function cachedGetVendorId(vpId) {
      const k = String(vpId);
      if (_vpIdCache.has(k)) return _vpIdCache.get(k);
      const result = await getVendorIdByVendorProductId(vpId);
      _vpIdCache.set(k, result);
      return result;
    }

    async function cachedVendorCostCenters(vendorProductId) {
      const k = String(vendorProductId);
      if (_vccCache.has(k)) return _vccCache.get(k);
      const docs = await VendorCostCenter.find({
        vendor_product: vendorProductId,
        status: { $in: ["Active", "active", null] },
      })
        .select(
          "vendor_size vendor_color standard_size standard_color base_cost sku " +
          "international priority additional_costs printing_method"
        )
        .lean();
      _vccCache.set(k, docs);
      return docs;
    }

    // ============== PASS 1: Pre-scan để chọn preferredVendorId ==============
    const stagedItems = [];
    const preItems = [];
    const candidateSetsPerItem = [];

    for (const item of order.items) {
      const { originalSku, mappedSku, usedSku } = getSkuForCost(item);

      const configCode = parseConfigCodeFromSKU(usedSku);
      if (!configCode) {
        stagedItems.push({
          orderItemId: item.orderItemId,
          sku: originalSku,
          mapped_sku: mappedSku,
          used_sku: usedSku,
          status: "failed",
          reason: "Cannot parse config code from SKU",
        });
        continue;
      }

      // (NEW) Check manual override first
      if (!ignoreManualMapping && item.manual_vendor_cost_center_id) {
        const vcc = await VendorCostCenter.findById(
          item.manual_vendor_cost_center_id
        ).lean();
        if (vcc && Number(vcc.base_cost || 0) > 0) {
          const vId = await cachedGetVendorId(vcc.vendor_product);
          preItems.push({
            item,
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
          // For manual selection, we "fake" a candidate set containing only this vendor
          // so that the intersection logic still works (or we can just skip it if forced)
          candidateSetsPerItem.push(new Set([vId]));
          continue;
        } else {
          console.warn(
            `Manual VCC ${item.manual_vendor_cost_center_id} not found or has 0 cost. Falling back to auto.`
          );
        }
      }

      const labelValueMap = extractLabelValueMapFromItem(item);
      const {
        cfg,
        productTypeValue,
        matchedBy,
        reason: cfgReason,
      } = await cachedSelectConfig(configCode, labelValueMap);

      if (!cfg) {
        stagedItems.push({
          orderItemId: item.orderItemId,
          sku: originalSku,
          mapped_sku: mappedSku,
          used_sku: usedSku,
          configCode,
          status: "failed",
          reason: cfgReason || "Config cost center not found by product type",
        });
        continue;
      }

      const sizeRaw = pickValueByKeys(
        labelValueMap,
        cfg.customize_size_key || []
      );
      const colorRaw = pickValueByKeys(
        labelValueMap,
        cfg.customize_color_key || []
      );

      const sizeMap = await cachedMapOptionValue({
        configCode,
        key: "size",
        rawValue: sizeRaw,
      });
      const colorMap = await cachedMapOptionValue({
        configCode,
        key: "color",
        rawValue: colorRaw,
      });

      const sizeValue = sizeMap.value;
      const colorValue = colorMap.value;

      let pfItems = toArray(cfg?.product_for_seller?.items).filter(Boolean);
      if (!pfItems.length) {
        stagedItems.push({
          orderItemId: item.orderItemId,
          sku: originalSku,
          mapped_sku: mappedSku,
          used_sku: usedSku,
          configCode,
          sizeValue,
          colorValue,
          status: "failed",
          reason: "product_for_seller has no items",
        });
        continue;
      }

      // Đặc thù EBM/EBMA
      if (["EBM", "EBMA"].includes(configCode.toUpperCase())) {
        // Chỉ lấy item Active
        const activeItems = toArray(cfg?.product_for_seller?.items)
          .filter(Boolean)
          .filter((x) => (x?.status || "").toLowerCase() === "active");

        // Ưu tiên đúng item order === 5
        const fifthByOrder = activeItems.find((x) => Number(x.order) === 5);

        if (fifthByOrder) {
          pfItems = [fifthByOrder];
        } else {
          const sorted = [...activeItems].sort(
            (a, b) => Number(a.order) - Number(b.order)
          );
          if (sorted.length >= 5) {
            pfItems = [sorted[4]];
            console.warn(
              "[EBM/EBMA] order===5 không tồn tại, fallback dùng phần tử thứ 5 sau sort theo 'order'."
            );
          } else {
            throw new Error(
              "[EBM/EBMA] Không tìm thấy item có order===5 và cũng không đủ 5 items để fallback."
            );
          }
        }
      }

      preItems.push({
        item,
        sku: originalSku,
        mapped_sku: mappedSku,
        used_sku: usedSku,
        configCode,
        productTypeValue,
        matchedBy,
        sizeValue,
        colorValue,
        pfItems,
      });

      // inline listCandidateVendors (cached)
      const vendorSet = new Set();
      for (const pf of pfItems) {
        const vpId = pf?.vendor_product;
        if (!vpId) continue;
        const candidates = await cachedVendorCostCenters(vpId);
        const hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: true });
        if (!hit) continue;
        const vId = String(
          pf?.vendor_id || pf?.vendor?._id || (await cachedGetVendorId(vpId)) || ""
        );
        if (vId) vendorSet.add(vId);
      }
      candidateSetsPerItem.push(vendorSet);
    }

    // (CODE MỚI) — KHÔNG ÉP vendor nếu đơn chỉ có 1 item.
    // Nếu có từ 2 item trở lên: giao vendor và chọn theo vendor-rank (pfItems.order)
    let preferredVendorId = !ignoreManualMapping && order.forced_vendor_id ? String(order.forced_vendor_id) : null;
    if (!preferredVendorId && preItems.length >= 2) {
      // inline buildVendorRank (cached)
      const vendorRank = new Map();
      for (const pre of preItems) {
        if (pre.manualVcc) continue; // Bỏ qua item đã được chọn thủ công khi tính rank chung
        for (const it of toArray(pre.pfItems)) {
          const vpId = it?.vendor_product;
          if (!vpId) continue;
          const vId = String(
            it?.vendor_id || it?.vendor?._id || (await cachedGetVendorId(vpId)) || ""
          );
          if (!vId) continue;
          const o = it.order ?? 999;
          vendorRank.set(vId, Math.min(vendorRank.get(vId) ?? 999, o));
        }
      }
      preferredVendorId =
        choosePreferredVendorIdStable(candidateSetsPerItem, vendorRank) || null;
    }

    logger.debug({
      message: "[BaseCost] vendor candidates resolved",
      candidateSetsPerItem: candidateSetsPerItem.map((s) => [...s]),
      preferredVendorId,
    });

    // ============== PASS 2: Chọn vendor_product & gom nhóm ship (vendor+profile) ==============
    const groups = new Map();

    for (const pre of preItems) {
      const {
        item,
        sku,
        mapped_sku,
        used_sku,
        configCode,
        productTypeValue,
        matchedBy,
        sizeValue,
        colorValue,
      } = pre;
      let { pfItems } = pre;

      // ===== inline selectBestVendorProduct (cached) =====
      const vendorSelection = await (async () => {
        // (NEW) Nếu đã có lựa chọn thủ công, trả về luôn
        if (pre.manualVcc) {
          return {
            success: true,
            vendorProductId: pre.manualVcc.vendor_product,
            matched: pre.manualVcc,
            selectedOrder: -1, // Manual
            itemDisplayName: "Manual Selection",
            vendorId: pre.vendorId,
          };
        }

        const byOrder = (a, b) => (a.order || 999) - (b.order || 999);
        const actives = pfItems
          .filter((it) => String(it.status || "").toLowerCase() === "active")
          .sort(byOrder);
        let itemsToCheck = actives.length ? actives : [...pfItems].sort(byOrder);

        const resolved = [];
        for (const it of itemsToCheck) {
          const vpId = it?.vendor_product;
          if (!vpId) continue;
          const vId = String(
            it?.vendor_id || it?.vendor?._id || (await cachedGetVendorId(vpId)) || ""
          );
          resolved.push({ ...it, __vendorId: vId, __vendorProductId: vpId });
        }

        const filtered = preferredVendorId
          ? resolved.filter((x) => x.__vendorId && String(x.__vendorId) === String(preferredVendorId))
          : resolved;
        if (preferredVendorId && filtered.length === 0) {
          return { success: false, reason: `No pfItems under forced vendor ${preferredVendorId}`, forcedVendorId: preferredVendorId };
        }

        const checkList = filtered.length ? filtered : resolved;
        for (const cItem of checkList) {
          const candidates = await cachedVendorCostCenters(cItem.__vendorProductId);
          if (!candidates?.length) continue;
          let hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: true });
          if (!hit) hit = findBestCostCenter(candidates, sizeValue, colorValue, { strict: false });
          if (hit && Number(hit?.base_cost || 0) > 0) {
            return {
              success: true, vendorProductId: cItem.__vendorProductId, matched: hit,
              selectedOrder: cItem.order || 999, itemDisplayName: cItem.display_name || "Unknown",
              vendorId: cItem.__vendorId,
            };
          }
        }

        return {
          success: false,
          reason: preferredVendorId
            ? `No matching cost center under forced vendor ${preferredVendorId}`
            : "No matching vendor product with valid cost center found",
          forcedVendorId: preferredVendorId || undefined,
          checkedItems: checkList.map((it) => ({
            order: it.order, display_name: it.display_name,
            vendor_product: String(it.__vendorProductId || ""), vendor_id: String(it.__vendorId || ""),
          })),
        };
      })();

      if (!vendorSelection.success) {
        stagedItems.push({
          orderItemId: item.orderItemId,
          sku,
          mapped_sku,
          used_sku,
          configCode,
          sizeValue,
          colorValue,
          status: "failed",
          reason: vendorSelection.reason,
          checkedItems: vendorSelection.checkedItems,
        });
        continue;
      }

      const {
        vendorProductId,
        matched,
        selectedOrder,
        itemDisplayName,
        vendorId,
      } = vendorSelection;

      const baseEach = Number(matched?.base_cost || 0) + 1; // +1$ per item surcharge
      const qty = Math.max(1, Number(item.quantity || 1));

      // ===== inline resolveShippingRates (cached) =====
      const rate = await (async () => {
        const shipType = String(shippingTypeForOrder || "").toLowerCase();
        const pickFromDoc = (doc, preferProfile) => {
          if (!doc) return null;
          const hasPriority = doc.priority && (doc.priority.economy != null || doc.priority.additional != null);
          const hasIntl = doc.international && (doc.international.economy != null || doc.international.additional != null);
          if (preferProfile === "priority" && hasPriority) return { eco: Number(doc.priority.economy ?? 0), add: Number(doc.priority.additional ?? 0), profile: "priority", source: "doc" };
          if (hasIntl) return { eco: Number(doc.international.economy ?? 0), add: Number(doc.international.additional ?? 0), profile: "international", source: "doc" };
          return null;
        };

        async function lookupFromCache(preferProfile) {
          if (!vendorProductId) return null;
          const allDocs = await cachedVendorCostCenters(vendorProductId);
          const normS = String(sizeValue || "").trim().toLowerCase();
          const normC = String(colorValue || "").trim().toLowerCase();
          // vendor_size/color
          for (const doc of allDocs) {
            if (normS && String(doc.vendor_size || "").trim().toLowerCase() === normS &&
              normC && String(doc.vendor_color || "").trim().toLowerCase() === normC) {
              const p = pickFromDoc(doc, preferProfile); if (p) return p;
            }
          }
          // standard_size/color
          for (const doc of allDocs) {
            if (normS && String(doc.standard_size || "").trim().toLowerCase() === normS &&
              normC && String(doc.standard_color || "").trim().toLowerCase() === normC) {
              const p = pickFromDoc(doc, preferProfile); if (p) return p;
            }
          }
          // fallback: any doc
          for (const doc of allDocs) {
            const p = pickFromDoc(doc, preferProfile); if (p) return p;
          }
          return null;
        }

        if (shipType === "expedited") {
          if (matched?.priority && (matched.priority.economy != null || matched.priority.additional != null))
            return { eco: Number(matched.priority.economy ?? 0), add: Number(matched.priority.additional ?? 0), profile: "priority", source: "matched" };
          const dbPick = await lookupFromCache("priority"); if (dbPick) return dbPick;
          if (matched?.international && (matched.international.economy != null || matched.international.additional != null))
            return { eco: Number(matched.international.economy ?? 0), add: Number(matched.international.additional ?? 0), profile: "international", source: "matched-fallback" };
          return { eco: 0, add: 0, profile: "priority", source: "zero" };
        }
        if (matched?.international && (matched.international.economy != null || matched.international.additional != null))
          return { eco: Number(matched.international.economy ?? 0), add: Number(matched.international.additional ?? 0), profile: "international", source: "matched" };
        const dbPick = await lookupFromCache("international"); if (dbPick) return dbPick;
        return { eco: 0, add: 0, profile: "international", source: "zero" };
      })();
      const eco = Number(rate.eco || 0);
      const add = Number(rate.add || 0);
      const shipProfile = rate.profile;

      // Additional costs
      const additionalCosts = {
        embroidery: 0,
        two_sided_print: 0,
        two_position_print: 0,
      };
      if (["TSB"].includes(configCode.toUpperCase())) {
        additionalCosts.two_sided_print = Number(
          matched?.additional_costs?.two_sided_print || 0
        );
      }
      if (["TS2S", "QZES"].includes(configCode.toUpperCase())) {
        additionalCosts.two_position_print = Number(
          matched?.additional_costs?.two_position_print || 0
        );
      }
      if (["EBM", "EBMA"].includes(configCode.toUpperCase())) {
        additionalCosts.embroidery = Number(
          matched?.additional_costs?.embroidery || 0
        );
      }
      const totalAdditionalCost =
        additionalCosts.embroidery +
        additionalCosts.two_sided_print +
        additionalCosts.two_position_print;

      const rec = {
        orderItemId: item.orderItemId,
        sku, // original
        mapped_sku,
        used_sku, // sku used for config/vendor selection
        configCode,
        productTypeValue: productTypeValue || null,
        selectedConfigBy: matchedBy || "unknown",
        sizeValue,
        colorValue,
        vendorProductId,
        vendorId,
        selectedOrder,
        itemDisplayName,
        baseEach,
        qty,
        eco,
        add,
        shipProfile,
        matchedSku: matched?.sku || null,
        printing_method: matched?.printing_method || "",
        additionalCosts,
        totalAdditionalCost,
        status: "ok",
      };
      stagedItems.push(rec);

      // group key (Không phụ thuộc vào eco/add để các item cùng vendor tự gộp chung)
      const shippingProfileKey = `${vendorId}::profile=${shipProfile}`;
      const g = groups.get(shippingProfileKey) || {
        vendorId,
        shipProfile,
        items: [],
        economyMax: 0,
      };
      g.items.push({ ...rec });
      g.economyMax = Math.max(g.economyMax, eco);
      groups.set(shippingProfileKey, g);
    }

    // ============== TÍNH TỔNG ==============
    const perItemResults = [];
    const groupBreakdowns = [];

    // 1) Base + additional (chưa shipping)
    for (const rec of stagedItems) {
      if (rec.status !== "ok") {
        perItemResults.push(rec);
        continue;
      }
      const basePart = rec.baseEach * rec.qty;
      const additionalPart = rec.totalAdditionalCost * rec.qty;

      perItemResults.push({
        orderItemId: rec.orderItemId,
        sku: rec.sku,
        mapped_sku: rec.mapped_sku,
        used_sku: rec.used_sku,
        configCode: rec.configCode,
        productTypeValue: rec.productTypeValue,
        selectedConfigBy: rec.selectedConfigBy,
        sizeValue: rec.sizeValue,
        colorValue: rec.colorValue,
        vendorProductId: rec.vendorProductId,
        vendorId: rec.vendorId || null,
        matchedSku: rec.matchedSku,
        printing_method: rec.printing_method || "",
        selectedOrder: rec.selectedOrder,
        itemDisplayName: rec.itemDisplayName,
        base_cost_each: rec.baseEach,
        quantity: rec.qty,
        additional_costs_breakdown: rec.additionalCosts,
        total_additional_cost_per_item: additionalPart,
        shipping_international_economy: 0,
        shipping_international_additional_units: 0,
        shipping_international_additional_rate: 0,
        base_cost_total_for_item_including_shipping: basePart + additionalPart,
        status: "ok",
      });
    }

    // 2) Phân bổ shipping
    const vendorBuckets = new Map(); // vendorId -> { items: [rec], profiles: Map(profileKey -> group) }
    for (const [profileKey, g] of groups.entries()) {
      const vId = g.vendorId;
      const buck = vendorBuckets.get(vId) || { items: [], profiles: new Map() };
      buck.items.push(...g.items);
      buck.profiles.set(profileKey, g);
      vendorBuckets.set(vId, buck);
    }

    for (const [vendorId, bucket] of vendorBuckets.entries()) {
      // const items = bucket.items;

      // // SPECIAL CASE: đúng 2 sản phẩm khác nhau, mỗi cái qty = 1
      // const distinctProducts = new Set(items.map((x) => x.vendorProductId))
      //   .size;
      // const totalQty = items.reduce((s, it) => s + it.qty, 0);
      // const allQtyAreOne = items.every((it) => Number(it.qty) === 1);

      // if (distinctProducts === 2 && totalQty === 2 && allQtyAreOne) {
      //   // reset ship trước
      //   for (const it of items) {
      //     const out = perItemResults.find(
      //       (r) => r.orderItemId === it.orderItemId && r.status === "ok"
      //     );
      //     if (!out) continue;
      //     const minus =
      //       (out.shipping_international_economy || 0) +
      //       (out.shipping_international_additional_units || 0) *
      //       (out.shipping_international_additional_rate || 0);
      //     out.base_cost_total_for_item_including_shipping = Number(
      //       (out.base_cost_total_for_item_including_shipping - minus).toFixed(2)
      //     );
      //     out.shipping_international_economy = 0;
      //     out.shipping_international_additional_units = 0;
      //     out.shipping_international_additional_rate = 0;
      //   }

      //   const sortedByShipExpensive = [...items].sort((a, b) => {
      //     if (b.eco !== a.eco) return b.eco - a.eco;
      //     return (b.baseEach || 0) - (a.baseEach || 0);
      //   });
      //   const expensive = sortedByShipExpensive[0];
      //   const cheap = sortedByShipExpensive[1];

      //   // eco cho sp "đắt hơn"
      //   {
      //     const out = perItemResults.find(
      //       (r) => r.orderItemId === expensive.orderItemId && r.status === "ok"
      //     );
      //     if (out) {
      //       out.shipping_international_economy = expensive.eco;
      //       out.base_cost_total_for_item_including_shipping = Number(
      //         (
      //           out.base_cost_total_for_item_including_shipping + expensive.eco
      //         ).toFixed(2)
      //       );
      //       out.formula = `${out.formula || ""} | SPECIAL[${expensive.shipProfile
      //         }]: eco(${expensive.eco}) for expensive product`;
      //     }
      //   }
      //   // additional (1) cho sp "rẻ hơn"
      //   {
      //     const out = perItemResults.find(
      //       (r) => r.orderItemId === cheap.orderItemId && r.status === "ok"
      //     );
      //     if (out) {
      //       out.shipping_international_additional_units = 1;
      //       out.shipping_international_additional_rate = cheap.add;
      //       out.base_cost_total_for_item_including_shipping = Number(
      //         (
      //           out.base_cost_total_for_item_including_shipping + cheap.add
      //         ).toFixed(2)
      //       );
      //       out.formula = `${out.formula || ""} | SPECIAL[${cheap.shipProfile
      //         }]: add(${cheap.add}) for cheaper product`;
      //     }
      //   }

      //   groupBreakdowns.push({
      //     group_key: `vendor:${vendorId}::SPECIAL_TWO_PRODUCTS`,
      //     vendor_id: vendorId,
      //     total_qty: 2,
      //     special_case: true,
      //     shipping_profile: expensive.shipProfile,
      //     rule: "eco of more expensive + additional of cheaper",
      //     shipping_total_for_group: Number(
      //       (expensive.eco + cheap.add).toFixed(2)
      //     ),
      //   });

      //   continue;
      // }

      // // ELSE: phân bổ theo từng profile
      // Phân bổ shipping theo từng profile (áp dụng chung 1 công thức đúng cho N items: Lấy economy đắt nhất trả 1 lần, còn lại trả thêm additional)
      for (const [profileKey, g] of bucket.profiles.entries()) {
        const totalQtyProfile = g.items.reduce((s, it) => s + it.qty, 0);
        if (totalQtyProfile <= 0) continue;

        const ecoOnce = g.economyMax; // charge 1 lần/profile
        let remainingEconomyToAssign = 1;
        let remainingAdditionalUnits = Math.max(0, totalQtyProfile - 1);

        // ưu tiên item eco cao trước
        const sorted = [...g.items].sort(
          (a, b) =>
            b.eco - a.eco ||
            String(a.orderItemId).localeCompare(String(b.orderItemId))
        );

        for (const it of sorted) {
          const out = perItemResults.find(
            (r) => r.orderItemId === it.orderItemId && r.status === "ok"
          );
          if (!out) continue;

          let ecoForThisItem = 0;
          if (remainingEconomyToAssign > 0 && it.qty > 0) {
            ecoForThisItem = ecoOnce;
            remainingEconomyToAssign = 0;
          }

          let addUnitsForThisItem = it.qty - (ecoForThisItem > 0 ? 1 : 0);
          addUnitsForThisItem = Math.max(
            0,
            Math.min(addUnitsForThisItem, remainingAdditionalUnits)
          );
          remainingAdditionalUnits -= addUnitsForThisItem;

          const addRate = it.add;
          const addCostForThisItem = addUnitsForThisItem * addRate;

          out.shipping_international_economy =
            (out.shipping_international_economy || 0) + ecoForThisItem;
          out.shipping_international_additional_units =
            (out.shipping_international_additional_units || 0) +
            addUnitsForThisItem;
          out.shipping_international_additional_rate = addRate;
          out.base_cost_total_for_item_including_shipping = Number(
            (
              out.base_cost_total_for_item_including_shipping +
              ecoForThisItem +
              addCostForThisItem
            ).toFixed(2)
          );
          out.formula = `(base ${it.baseEach} * qty ${it.qty}) + additional ${it.totalAdditionalCost} * qty ${it.qty} + [${g.shipProfile}] eco ${ecoForThisItem} + add ${addRate} * ${addUnitsForThisItem} | Selected: Order ${out.selectedOrder} - ${out.itemDisplayName}`;
        }

        const shippingTotalForGroup = Number(
          (
            ecoOnce +
            g.items.reduce((sum, it) => {
              const out = perItemResults.find(
                (r) => r.orderItemId === it.orderItemId && r.status === "ok"
              );
              if (!out) return sum;
              return (
                sum +
                (out.shipping_international_additional_units || 0) *
                (out.shipping_international_additional_rate || 0)
              );
            }, 0)
          ).toFixed(2)
        );

        groupBreakdowns.push({
          group_key: profileKey,
          vendor_id: g.vendorId,
          total_qty: totalQtyProfile,
          shipping_profile: g.shipProfile,
          shipping_economy_once: ecoOnce,
          shipping_total_for_group: shippingTotalForGroup,
        });
      }
    }

    // 3) Lưu breakdown vào model (audit sku rõ ràng)
    for (const out of perItemResults) {
      if (out.status !== "ok") continue;
      const itemRef = order.items.find(
        (i) => String(i.orderItemId) === String(out.orderItemId)
      );
      if (!itemRef) continue;

      itemRef.cost_breakdown = {
        used_sku: out.used_sku || null,
        original_sku: out.sku || null,
        mapped_sku: out.mapped_sku || null,

        configCode: out.configCode,
        productTypeValue: out.productTypeValue || null,
        selectedConfigBy: out.selectedConfigBy || null,
        sizeValue: out.sizeValue,
        colorValue: out.colorValue,
        vendorProductId: out.vendorProductId || null,
        matchedSku: out.matchedSku || null,
        selectedOrder: out.selectedOrder,
        itemDisplayName: out.itemDisplayName,
        base_cost_each: out.base_cost_each,
        quantity: out.quantity,
        additional_costs_breakdown: out.additional_costs_breakdown,
        total_additional_cost_per_item: out.total_additional_cost_per_item,
        shipping_international_economy: out.shipping_international_economy,
        shipping_international_additional_units:
          out.shipping_international_additional_units,
        shipping_international_additional_rate:
          out.shipping_international_additional_rate,
        base_cost_total_for_item_including_shipping:
          out.base_cost_total_for_item_including_shipping,
        formula: out.formula,
      };
    }

    order.base_cost_shipping_groups = groupBreakdowns;

    let orderTotalBaseCost = 0;
    for (const it of order.items) {
      if (
        it.cost_breakdown &&
        typeof it.cost_breakdown.base_cost_total_for_item_including_shipping ===
        "number"
      ) {
        orderTotalBaseCost +=
          it.cost_breakdown.base_cost_total_for_item_including_shipping;
      }
    }
    order.base_cost = Number(orderTotalBaseCost.toFixed(2));
    order.base_cost_computed_at = new Date();

    if (!dryRun) {
      await order.save();
    }

    const changes = buildBaseCostComputeChanges({
      oldBaseCost,
      newBaseCost: order.base_cost,
      oldShippingGroups,
      newShippingGroups: order.base_cost_shipping_groups,
      oldComputedAt,
      newComputedAt: order.base_cost_computed_at,
      oldItemBreakdowns,
      items: order.items,
    });

    if (!dryRun && changes.length > 0) {
      await logOrderHistory({
        orderDoc: order,
        action: "UPDATE_BASE_COST",
        description: "Order base cost computed",
        changes,
        user: req.user,
        context: {
          source: req.user ? "PORTAL" : "SYSTEM",
          ip: req.ip,
          userAgent: req.headers?.["user-agent"],
        },
      });
    }

    const failedItems = perItemResults.filter((item) => item.status !== "ok");
    const lifecycleStatus =
      failedItems.length > 0 || Number(order.base_cost || 0) <= 0
        ? "failed"
        : "success";
    const firstFailureReason =
      failedItems[0]?.reason ||
      (Number(order.base_cost || 0) <= 0 ? "Computed base cost is 0" : "");

    if (!dryRun) {
      await logOrderLifecycleEvent(buildOrderLifecyclePayload({
        order,
        req,
        fallbackPlatform: "amazon",
        stage: "AUTO_COST",
        eventType:
          lifecycleStatus === "success"
            ? "AUTO_COST_RETEST_SUCCESS"
            : "AUTO_COST_RETEST_FAILED",
        status: lifecycleStatus,
        message: "Order base cost re-tested",
        reason: firstFailureReason,
        metadata: {
          oldBaseCost,
          newBaseCost: order.base_cost,
          itemCount: Array.isArray(order.items) ? order.items.length : 0,
          failedItemCount: failedItems.length,
          shippingGroupCount: groupBreakdowns.length,
          failedItems: failedItems.slice(0, 10).map((item) => ({
            orderItemId: item.orderItemId,
            sku: item.used_sku || item.sku || "",
            configCode: item.configCode || "",
            reason: item.reason || "",
          })),
        },
      }));
    }

    return res.json({
      message:
        "Computed base cost with vendor-preference & consolidated shipping (priority for Expedited, international otherwise)",
      orderId,
      dryRun,
      ignore_manual_mapping: ignoreManualMapping,
      base_cost: order.base_cost,
      preferred_vendor_id: preferredVendorId || null,
      shipping_group_breakdowns: groupBreakdowns,
      detail: perItemResults,
    });
  } catch (err) {
    await logOrderLifecycleEvent(buildOrderLifecyclePayload({
      order: order || { orderId, platform: "amazon" },
      req,
      fallbackPlatform: "amazon",
      stage: "AUTO_COST",
      eventType: "AUTO_COST_RETEST_FAILED",
      status: "failed",
      message: "Order base cost re-test failed",
      reason: err.message,
      metadata: {
        itemCount: Array.isArray(order?.items) ? order.items.length : 0,
      },
    }));
    return res
      .status(500)
      .json({ message: "Compute failed", error: err.message });
  }
};

const autoMatchBaseCostForOrder = (req, res) =>
  computeBaseCostForOrder({
    ...req,
    body: {
      ...req.body,
      ignoreManualMapping: true,
      dryRun: req.body?.dryRun !== false,
    },
  }, res);

/**
 * POST body: { limit?: number }
 * Tính cho nhiều đơn còn thiếu base_cost (0/null), giới hạn tối đa 200
 */
const computeBaseCostForMany = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.body?.limit || 50)));
    const orders = await OrderCustomProduct.find({
      $or: [
        { base_cost: { $exists: false } },
        { base_cost: { $in: [0, null] } },
      ],
    })
      .sort({ purchase_date: -1 })
      .limit(limit);

    const results = [];
    for (const o of orders) {
      const fakeReq = {
        body: { orderId: o.orderId },
        user: req.user,
        ip: req.ip,
        headers: req.headers,
      };
      const fakeRes = {
        json: (r) => results.push({ orderId: o.orderId, ...r }),
        status: (code) => ({
          json: (r) => results.push({ orderId: o.orderId, code, ...r }),
        }),
      };
      // eslint-disable-next-line no-await-in-loop
      await computeBaseCostForOrder(fakeReq, fakeRes);
    }
    return res.json({
      message: "Batch computed",
      count: results.length,
      results,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Batch compute failed", error: err.message });
  }
};
// ================== END BASE COST ==================

function computeOrderStatusFromItems(items = []) {
  const itemStatuses = items.map((i) => norm(i?.tracking_info?.status));
  const active = itemStatuses.filter((s) => !isCanceledStatus(s));
  if (active.length === 0) return "Cancelled";
  if (active.every((s) => s === "Shipped")) return "Shipped";
  const hasNew = active.includes("New");
  const hasShipping = active.includes("Shipping");
  const hasFulfilled = active.includes("Fulfilled");
  const allFulfilledOrShipped = active.every(
    (s) => s === "Fulfilled" || s === "Shipping" || s === "Shipped"
  );
  if (!hasNew && hasShipping && allFulfilledOrShipped) return "Shipping";
  if (!hasNew && hasFulfilled && allFulfilledOrShipped) return "Fulfilled";
  return "New";
}

const unique = (arr) => [
  ...new Set(arr.filter((v) => v !== undefined && v !== null)),
];

const summarizeItemsField = (items, pickFn) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  return unique(
    items.map(pickFn).map((v) => (typeof v === "string" ? v.trim() : v))
  );
};

/**
 * PATCH /orders/:orderId/items/:orderItemId/tracking
 * Body: { fulfillment?, tracking?, status?, note? }
 * Rule thêm: nếu tracking có giá trị -> ép item.status = 'Shipped'
 * (Lưu ý: code hiện tại đang update ALL items bằng $[], param orderItemId không được dùng)
 */
const updateItemTracking = async (req, res) => {
  try {
    const { orderId } = req.params;
    const user = req.user;

    // an toàn khi req.body undefined
    const body = req.body || {};
    let { fulfillment, tracking, status, note } = body;

    // Chuẩn hoá chuỗi
    const tFulfillment =
      fulfillment !== undefined ? String(fulfillment).trim() : undefined;
    const tTracking =
      tracking !== undefined ? String(tracking).trim() : undefined;
    const tNote = note !== undefined ? String(note) : undefined;
    const tStatus = status !== undefined ? String(status).trim() : undefined;

    // Validate status nếu có
    if (tStatus && !ALLOWED.includes(tStatus)) {
      return res
        .status(400)
        .json({ message: "Invalid status", allowed: ALLOWED });
    }

    // Nếu không có field nào để update -> trả 400 sớm
    if (
      tFulfillment === undefined &&
      tTracking === undefined &&
      tStatus === undefined &&
      tNote === undefined
    ) {
      return res.status(400).json({
        message:
          "No updatable fields provided (fulfillment/tracking/status/note)",
      });
    }

    // RULE ưu tiên:
    // 1) Nếu status = Cancelled -> ưu tiên Cancelled (bỏ qua auto-ship theo tracking)
    // 2) Ngược lại, nếu có tracking -> ép Shipped
    // 3) Còn lại -> dùng status được truyền (nếu có)
    let nextStatus;
    if (isCanceledStatus(tStatus)) {
      nextStatus = "Cancelled";
    } else if (tTracking !== undefined && tTracking.length > 0) {
      nextStatus = "Shipped";
    } else {
      nextStatus = tStatus; // có thể undefined
    }

    // ===== Fetch BEFORE để lấy old order.status cho log =====
    const beforeDoc = await OrderCustomProduct.findOne(
      { orderId },
      { orderId: 1, status: 1 }
    ).lean();

    if (!beforeDoc) {
      return res.status(404).json({ message: "Order not found" });
    }

    const oldOrderStatus = beforeDoc.status;
    // ========================================================

    const $set = {};

    // Apply cho TẤT CẢ items
    if (tFulfillment !== undefined)
      $set["items.$[].tracking_info.fulfillment"] = tFulfillment;
    if (tTracking !== undefined)
      $set["items.$[].tracking_info.tracking"] = tTracking;
    if (tNote !== undefined) $set["items.$[].tracking_info.note"] = tNote;

    // cập nhật updated_at cho tất cả items
    $set["items.$[].tracking_info.updated_at"] = new Date();

    // Set status cho tất cả items nếu xác định được nextStatus
    if (nextStatus !== undefined) {
      $set["items.$[].tracking_info.status"] = nextStatus;

      if (nextStatus === "Fulfilled" || nextStatus === "Shipping" || nextStatus === "Shipped") {
        // Item hoàn tất scale, order coi như đã gửi
        $set["items.$[].scale_status"] = "Complete";
        $set["scale_overall_status"] = "Sent";
      } else if (nextStatus === "Cancelled") {
        // Import/cancel reset keeps item scale_status inside the schema enum.
        $set["items.$[].scale_status"] = IMPORT_SCALE_STATUS;
        $set["scale_overall_status"] = "Cancelled";
      }
      // (Các trạng thái khác nếu có, ta không ép scale_overall_status)
    }

    // Update & lấy document mới
    const docAfterAllUpdate = await OrderCustomProduct.findOneAndUpdate(
      { orderId },
      { $set },
      { new: true }
    );

    if (!docAfterAllUpdate) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Đồng bộ lại order.status từ items
    const newOrderStatus = computeOrderStatusFromItems(docAfterAllUpdate.items);
    if (newOrderStatus !== docAfterAllUpdate.status) {
      await OrderCustomProduct.updateOne(
        { _id: docAfterAllUpdate._id },
        { $set: { status: newOrderStatus } }
      );
      // sync lại instance để trả response nhất quán (không bắt buộc)
      docAfterAllUpdate.status = newOrderStatus;
    }

    // ===== LOGGER: CHỈ log field status =====
    if (oldOrderStatus !== newOrderStatus) {
      await logOrderHistory({
        orderDoc: docAfterAllUpdate, // có _id + orderId
        action: "UPDATE_STATUS",
        description: `Order status changed from ${oldOrderStatus} to ${newOrderStatus}`,
        changes: [
          {
            field: "status",
            from: oldOrderStatus,
            to: newOrderStatus,
          },
        ],
        user,
        context: {
          source: "PORTAL",
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
      });
    }
    // =======================================

    // scale_overall_status phản hồi: nếu ta vừa set thì trả về giá trị mới; nếu không, trả doc hiện tại
    const responseScaleOverall =
      nextStatus === "Fulfilled" || nextStatus === "Shipped"
        ? "Sent"
        : nextStatus === "Cancelled"
          ? "Cancelled"
          : docAfterAllUpdate.scale_overall_status;

    return res.json({
      message:
        "Tracking updated for ALL items (priority: Cancelled > auto-Ship on tracking). Item & order statuses synced.",
      orderId: docAfterAllUpdate.orderId,
      orderStatus: newOrderStatus,
      scale_overall_status: responseScaleOverall,
      applied: {
        fulfillment: tFulfillment,
        tracking: tTracking,
        status: nextStatus,
        note: tNote,
      },
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Update failed", error: err.message });
  }
};

/**
 * Tạo orderId mới với hậu tố -R1 (nếu trùng thì R2, R3...)
 */
async function buildNextReplaceOrderId(baseOrderId) {
  // Nếu đã có hậu tố -R\d rồi thì bỏ đi để lấy "gốc"
  const base = String(baseOrderId).replace(/-R\d+$/i, "");
  const regex = new RegExp(`^${base}-R(\\d+)$`, "i");
  const exists = await OrderCustomProduct.find(
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
 * Làm sạch 1 item để dùng cho đơn replace
 * - Giữ nguyên customization/version3/baseImage/snapshot (để sản xuất lại)
 * - Reset các field fulfillment/shipping/tracking/scale/cost
 */
function sanitizeItemForReplace(srcItem) {
  const dst = JSON.parse(JSON.stringify(srcItem)); // deep clone plain

  // ID item mới
  dst.orderItemId = new mongoose.Types.ObjectId().toHexString();

  // Reset các field không nên mang sang
  dst.fulfillment_file = {};
  dst.tracking_info = {
    fulfillment: "",
    tracking: "",
    status: "New",
    note: "",
    updated_at: new Date(),
  };
  dst.scale_status = "Need Scale";
  dst.qc_note = "";
  dst.cs_note = "";

  // cost breakdown tính lại sau
  dst.cost_breakdown = undefined;

  // quantity giữ nguyên (có thể cho phép override trong tương lai)
  dst.quantity = Number(srcItem.quantity || 1);

  // các field còn lại: sku/mapped_sku/title/customization/… giữ nguyên
  return dst;
}

/**
 * POST /orders/:orderId/replace
 * Body:
 *   - orderItemIds?: string[]  (bắt buộc nếu đơn có >1 item)
 *   - note?: string            (ghi chú lý do replace, sẽ gắn vào cs_note của items mới)
 */
async function createReplacementOrder(req, res) {
  try {
    const { orderId } = req.params;
    const { orderItemIds, note } = req.body || {};

    // 1) Lấy đơn gốc
    const src = await OrderCustomProduct.findOne({ orderId }).lean();
    if (!src) return res.status(404).json({ message: "Order not found" });

    const totalItems = Array.isArray(src.items) ? src.items.length : 0;
    if (totalItems === 0)
      return res.status(400).json({ message: "Source order has no items" });

    // 2) Xác định danh sách item được replace
    let selected = [];
    if (totalItems === 1) {
      selected = [src.items[0]];
    } else {
      if (!Array.isArray(orderItemIds) || orderItemIds.length === 0) {
        return res.status(400).json({
          message:
            "This order has multiple items. Please provide body.orderItemIds as an array of orderItemId to replace.",
          availableItemIds: src.items.map((i) => i.orderItemId),
        });
      }
      const setIds = new Set(orderItemIds.map(String));
      selected = src.items.filter((it) => setIds.has(String(it.orderItemId)));
      if (selected.length === 0) {
        return res.status(400).json({
          message: "No matching orderItemIds found in source order",
          availableItemIds: src.items.map((i) => i.orderItemId),
        });
      }
    }

    // 3) Tạo orderId mới theo -R1/-R2…
    const newOrderId = await buildNextReplaceOrderId(src.orderId);

    // 4) Build items mới
    const newItems = selected.map((it) => {
      const clean = sanitizeItemForReplace(it);
      if (note) clean.cs_note = String(note);
      return clean;
    });

    // 5) Dữ liệu đơn mới
    const dstPayload = {
      orderId: newOrderId,
      items: newItems,

      // copy các trường chung
      customer_infor: src.customer_infor || null,
      shopId: src.shopId || null,
      sellerId: src.sellerId || null,
      shipping_type: src.shipping_type || "Standard",
      platform: src.platform || "Amazon",
      status: "New",
      scale_overall_status: "Need Scale",

      // reset các tổng hợp / tài chính
      base_cost: 0,
      base_cost_shipping_groups: [],
      amazon_total_quantity: newItems.reduce(
        (s, it) => s + Number(it.quantity || 1),
        0
      ),

      // metadata replace (không đụng schema hiện tại nếu chưa có field — chỉ lưu thêm key mềm)
      replace_meta: {
        is_replacement: true,
        replace_of_order_id: src.orderId,
        created_at: new Date(),
        reason: note || "",
      },

      // thời gian: để createdAt/purchase_date tách biệt; purchase_date = now
      purchase_date: new Date(),
    };

    // 6) Tạo đơn
    const created = await OrderCustomProduct.create(dstPayload);

    try {
      const validationResult = await validateAddressWithSmarty(
        created.customer_infor
      );

      // cập nhật trường theo đúng model
      created.address_validation = {
        isValid: !!validationResult?.isValid,
        smartyResponse:
          validationResult?.smartyResponse || validationResult || null,
      };

      // Nếu địa chỉ không hợp lệ => đánh dấu trạng thái tổng để chặn tuyến fulfill/gửi Grabink
      if (created.address_validation.isValid === false) {
        created.scale_overall_status = "Address Invalid"; // enum đã có trong model
      }

      await created.save();
    } catch (e) {
      // Nếu gọi dịch vụ validate lỗi: giữ nguyên null để có thể retry sau
      created.address_validation = { isValid: null, smartyResponse: null };
      await created.save();
    }

    // 6.2) Trả về chi tiết rõ ràng để FE hiển thị ngay
    return res.json({
      message: "Replacement order created",
      source_order_id: src.orderId,
      replacement_order_id: created.orderId,
      items_copied: newItems.length,
      selected_order_item_ids: newItems.map((i) => i.orderItemId),
      address_validation: created.address_validation, // <-- khớp model
      scale_overall_status: created.scale_overall_status, // <-- khớp model
    });
  } catch (err) {
    console.error("createReplacementOrder error:", err);
    return res.status(500).json({
      message: "Failed to create replacement order",
      error: err.message,
    });
  }
}

const updateScaleOrder = async (req, res) => {
  const user = await OrderCustomProduct.findByIdAndUpdate(
    req.params.orderId,
    req.body,
    {
      new: true,
    }
  );
  res.json(user);
};


/**
 * POST /update-tracking
 * Body: { orderId: string, tracking: string }
 * Tìm order theo orderId → duyệt tất cả items → cập nhật tracking_info.tracking
 * Nếu tracking có giá trị → tự động set status = "Shipped"
 */
const updateTrackingByOrderId = async (req, res) => {
  try {
    const { orderId, tracking } = req.body;

    if (!orderId) {
      return res.status(400).json({ message: "orderId is required" });
    }
    if (tracking === undefined || tracking === null) {
      return res.status(400).json({ message: "tracking is required" });
    }

    const tTracking = String(tracking).trim();

    // Nếu có tracking → auto set status Shipped
    const nextItemStatus = tTracking.length > 0 ? "Shipped" : undefined;

    const $set = {
      "items.$[].tracking_info.tracking": tTracking,
      "items.$[].tracking_info.updated_at": new Date(),
    };

    if (nextItemStatus) {
      $set["items.$[].tracking_info.status"] = nextItemStatus;
    }

    const order = await OrderCustomProduct.findOneAndUpdate(
      { orderId },
      { $set },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Sync order-level status
    const newOrderStatus = computeOrderStatusFromItems(order.items);
    if (newOrderStatus !== order.status) {
      await OrderCustomProduct.updateOne(
        { _id: order._id },
        { $set: { status: newOrderStatus } }
      );
      order.status = newOrderStatus;
    }

    return res.json({
      message: "Tracking updated for all items",
      orderId: order.orderId,
      orderStatus: order.status,
      tracking: tTracking,
      itemsUpdated: order.items.length,
    });
  } catch (err) {
    console.error("updateTrackingByOrderId error:", err);
    return res.status(500).json({ message: "Update failed", error: err.message });
  }
};

/**
 * PUT /api/orders/manual-mapping
 * Cho phép Seller ép Vendor cho cả đơn hoặc ép một record VendorCostCenter cụ thể cho từng item.
 */
const applyManualVendorMapping = async (req, res) => {
  try {
    const { orderId, forcedVendorId, items } = req.body;
    if (!orderId) return res.status(400).json({ message: "orderId is required" });

    const order = await OrderCustomProduct.findOne({ orderId });
    if (!order) {
      const etsyOrder = await EtsyOrder.findOne({ orderId });
      if (!etsyOrder) return res.status(404).json({ message: "Order not found" });

      const changes = [];
      const oldForcedVendorId = etsyOrder.forced_vendor_id
        ? String(etsyOrder.forced_vendor_id)
        : null;

      if (forcedVendorId !== undefined) {
        const nextForcedVendorId = forcedVendorId || null;
        const nextForcedVendorIdStr = nextForcedVendorId
          ? String(nextForcedVendorId)
          : null;

        if (oldForcedVendorId !== nextForcedVendorIdStr) {
          changes.push({
            field: "forced_vendor_id",
            from: oldForcedVendorId,
            to: nextForcedVendorIdStr,
          });
        }

        etsyOrder.forced_vendor_id = nextForcedVendorId;
      }

      if (Array.isArray(items)) {
        for (const override of items) {
          const overrideItemId = override.transactionId || override.orderItemId;
          const item = etsyOrder.items.find(
            (i) => String(i.transactionId) === String(overrideItemId)
          );
          if (item) {
            const oldManualVendorCostCenterId = item.manual_vendor_cost_center_id
              ? String(item.manual_vendor_cost_center_id)
              : null;
            const nextManualVendorCostCenterId = override.vendorCostCenterId || null;
            const nextManualVendorCostCenterIdStr = nextManualVendorCostCenterId
              ? String(nextManualVendorCostCenterId)
              : null;

            if (oldManualVendorCostCenterId !== nextManualVendorCostCenterIdStr) {
              changes.push({
                field: `items[transactionId=${item.transactionId}].manual_vendor_cost_center_id`,
                from: oldManualVendorCostCenterId,
                to: nextManualVendorCostCenterIdStr,
              });
            }

            item.manual_vendor_cost_center_id = nextManualVendorCostCenterId;

            if (!override.vendorCostCenterId) {
              item.cost_breakdown = null;
            }
          }
        }
      }

      await etsyOrder.save();

      if (changes.length > 0) {
        await logOrderHistory({
          orderDoc: etsyOrder,
          action: "UPDATE_MANUAL_VENDOR_MAPPING",
          description: "Manual vendor mapping updated for Etsy order",
          changes,
          user: req.user,
          context: {
            source: "PORTAL",
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          },
        });
      }

      let computedResult = null;
      const { computeBaseCostForEtsyOrder } = require("./etsyOrder.controller");
      const mockReq = { body: { orderId } };
      const mockRes = {
        status: function () { return this; },
        json: function (data) { computedResult = data; return this; }
      };

      await computeBaseCostForEtsyOrder(mockReq, mockRes);

      return res.json({
        message: "Manual mapping applied successfully",
        platform: "etsy",
        orderId,
        computed_info: computedResult
      });
    }

    const changes = [];
    const oldForcedVendorId = order.forced_vendor_id
      ? String(order.forced_vendor_id)
      : null;

    if (forcedVendorId !== undefined) {
      const nextForcedVendorId = forcedVendorId || null;
      const nextForcedVendorIdStr = nextForcedVendorId
        ? String(nextForcedVendorId)
        : null;

      if (oldForcedVendorId !== nextForcedVendorIdStr) {
        changes.push({
          field: "forced_vendor_id",
          from: oldForcedVendorId,
          to: nextForcedVendorIdStr,
        });
      }

      order.forced_vendor_id = nextForcedVendorId;
    }

    if (Array.isArray(items)) {
      for (const override of items) {
        const item = order.items.find(
          (i) => String(i.orderItemId) === String(override.orderItemId)
        );
        if (item) {
          const oldManualVendorCostCenterId = item.manual_vendor_cost_center_id
            ? String(item.manual_vendor_cost_center_id)
            : null;
          const nextManualVendorCostCenterId = override.vendorCostCenterId || null;
          const nextManualVendorCostCenterIdStr = nextManualVendorCostCenterId
            ? String(nextManualVendorCostCenterId)
            : null;

          if (oldManualVendorCostCenterId !== nextManualVendorCostCenterIdStr) {
            changes.push({
              field: `items[orderItemId=${item.orderItemId}].manual_vendor_cost_center_id`,
              from: oldManualVendorCostCenterId,
              to: nextManualVendorCostCenterIdStr,
            });
          }

          item.manual_vendor_cost_center_id = nextManualVendorCostCenterId;

          // 👉 Xoá breakdown cũ nếu user huỷ manual mapping để hàm compute ép tính lại từ đầu
          if (!override.vendorCostCenterId) {
            item.cost_breakdown = null;
          }
        }
      }
    }

    // Lưu lại manual_vendor_cost_center_id trước
    await order.save();

    if (changes.length > 0) {
      await logOrderHistory({
        orderDoc: order,
        action: "UPDATE_MANUAL_VENDOR_MAPPING",
        description: "Manual vendor mapping updated",
        changes,
        user: req.user,
        context: {
          source: "PORTAL",
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        },
      });
    }

    // 👉 GỌI TRỰC TIẾP HÀM computeBaseCostForOrder ĐỂ TỰ ĐỘNG GOM NHÓM VÀ TÍNH SHIP CHUẨN XÁC DO MÌNH VỪA FIX
    // Tránh việc tự cộng dồn tay gộp shipping sai ở đây.
    let computedResult = null;
    const mockReq = {
      body: { orderId },
      user: req.user,
      ip: req.ip,
      headers: req.headers,
    };
    const mockRes = {
      status: function () { return this; },
      json: function (data) { computedResult = data; return this; }
    };

    await computeBaseCostForOrder(mockReq, mockRes);

    return res.json({
      message: "Manual mapping applied successfully",
      orderId,
      computed_info: computedResult
    });
  } catch (err) {
    console.error("applyManualVendorMapping error:", err);
    return res.status(500).json({ message: "Update failed", error: err.message });
  }
};

const updateOrderItemQuantity = async (req, res) => {
  try {
    const { orderId, orderItemId } = req.params;
    const { quantity } = req.body;

    // validate input
    if (quantity === undefined || quantity === null) {
      return res.status(400).json({
        message: "Quantity is required",
      });
    }

    const parsedQuantity = Number(quantity);

    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
      return res.status(400).json({
        message: "Quantity must be an integer greater than 0",
      });
    }

    const existingOrder = await OrderCustomProduct.findOne({
      orderId,
      "items.orderItemId": orderItemId,
    });

    if (!existingOrder) {
      return res.status(404).json({
        message: "Order or order item not found",
      });
    }

    const existingItem = existingOrder.items.find(
      (item) => item.orderItemId === orderItemId
    );
    const oldQuantity = existingItem?.quantity ?? null;

    if (oldQuantity === parsedQuantity) {
      return res.status(200).json({
        message: "No change",
        data: {
          orderId,
          orderItemId,
          quantity: parsedQuantity,
        },
      });
    }

    // update đúng item trong mảng items
    const updatedOrder = await OrderCustomProduct.findOneAndUpdate(
      {
        orderId,
        "items.orderItemId": orderItemId,
      },
      {
        $set: {
          "items.$[item].quantity": parsedQuantity,
        },
      },
      {
        new: true,
        arrayFilters: [{ "item.orderItemId": orderItemId }],
      }
    );

    if (!updatedOrder) {
      return res.status(404).json({
        message: "Order or order item not found",
      });
    }

    // lấy lại item vừa update
    const updatedItem = updatedOrder.items.find(
      (item) => item.orderItemId === orderItemId
    );

    await logOrderHistory({
      orderDoc: updatedOrder,
      action: "UPDATE_ITEM_QUANTITY",
      description: `Order item quantity changed from ${oldQuantity} to ${updatedItem?.quantity || parsedQuantity}`,
      changes: [
        {
          field: "items.quantity",
          from: oldQuantity,
          to: updatedItem?.quantity || parsedQuantity,
        },
      ],
      orderItemId,
      user: req.user,
      context: {
        source: "PORTAL",
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      },
    });

    return res.status(200).json({
      message: "Order item quantity updated successfully",
      data: {
        orderId: updatedOrder.orderId,
        orderItemId,
        quantity: updatedItem?.quantity || parsedQuantity,
      },
    });
  } catch (error) {
    return res.status(500).json({
      message: "Failed to update order item quantity",
      error: error.message,
    });
  }
};

module.exports = {
  // getAllOrders,
  getOrderById,
  getFrontendOrders,
  upload,
  updateOrdersFromXlsx,
  bulkCancelOrdersFromExcel,
  updateOrderStatus,
  updateShippingType,
  updateBaseCost,
  resetBaseCost,
  updateCustomerInfo,
  openCaseInOrder,
  getOrderStatistics,
  removeCaseFromOrder,
  updateBaseImageUrl,
  computeBaseCostForOrder,
  autoMatchBaseCostForOrder,
  computeBaseCostForMany,
  updateItemTracking,
  createReplacementOrder,
  updateScaleOrder,
  validateAddressByOrderId,
  markAddressValidByOrderId,
  validateInvalidAddressesBatch,
  updateTrackingByOrderId,
  applyManualVendorMapping,
  updateOrderItemQuantity
};
