// controllers/listing.controller.js
const db = require("../models");
const multer = require("multer");
const Listing = db.listing;
const OrderCustomProduct = db.orderCustomProduct;
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

// ✅ dùng các helper từ utils/wasabi
const {
  uploadBufferToWasabi,
  getSignedUrlForKey,
  buildPsdKeyFromAsin,
} = require("../utils/wasabi");

// ==============================
// GET list (paging + filter + sort + populate)
// ==============================
const getListings = async (req, res) => {
  try {
    const {
      page = 1,
      perPage = 10,
      asinType,
      asinTypeMode,
      seller,
      platform,
      sort = "createdAt",
      order = "desc",
      search,
      psdStatus,
      from,
      to,
      store,
    } = req.query;

    const filter = {};

    // ===== RBAC =====
    const role = req.user?.role;
    const userId = req.user?.userId;

    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);

    if (isSeller && !isAdmin) {
      filter.seller = userId;
    } else if (seller) {
      filter.seller = seller;
    }

    // Filters
    if (asinType) filter.asin_type = asinType;
    if (asinTypeMode === "excludeOutline") {
      filter.asin_type = { $ne: "Outline" };
    } else if (asinTypeMode === "onlyOutline") {
      filter.asin_type = "Outline";
    }

    if (platform) filter.platform = platform;
    if (store) filter.store = store;

    if (psdStatus) {
      const statuses = psdStatus
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 1) {
        filter["psd.status"] = statuses[0];
      } else if (statuses.length > 1) {
        filter["psd.status"] = { $in: statuses };
      }
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    if (search) {
      const regex = new RegExp(search, "i");
      filter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(perPage, 10) || 10, 1);
    const skip = (pageNum - 1) * limitNum;

    const total = await Listing.countDocuments(filter);

    let listings;

    if (sort === "total_sales") {
      const allListings = await Listing.find(filter)
        .populate({ path: "seller", select: "full_name" })
        .populate({ path: "store", select: "name" })
        .lean();

      const listingIds = allListings.map((l) => l._id).filter(Boolean);
      let salesMap = new Map();

      if (listingIds.length > 0) {
        const agg = await OrderCustomProduct.aggregate([
          { $match: { "items.listingId": { $in: listingIds } } },
          { $unwind: "$items" },
          { $match: { "items.listingId": { $in: listingIds } } },
          {
            $group: {
              _id: { listingId: "$items.listingId", orderId: "$orderId" },
            },
          },
          { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
        ]);

        salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
      }

      const listingsWithSales = allListings.map((l) => ({
        ...l,
        total_sales: salesMap.get(String(l._id)) || 0,
      }));

      listingsWithSales.sort((a, b) =>
        order === "asc"
          ? a.total_sales - b.total_sales
          : b.total_sales - a.total_sales
      );

      // Pagination sau khi sort
      listings = listingsWithSales.slice(skip, skip + limitNum);

    } else if (sort === "seller_name") {
      const pipeline = [
        { $match: filter },
        {
          $lookup: {
            from: "users",
            localField: "seller",
            foreignField: "_id",
            as: "seller",
          },
        },
        { $unwind: { path: "$seller", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "stores",
            localField: "store",
            foreignField: "_id",
            as: "store",
          },
        },
        { $unwind: { path: "$store", preserveNullAndEmptyArrays: true } },
        {
          $addFields: {
            seller_name: { $ifNull: ["$seller.full_name", ""] },
          },
        },
        { $sort: { seller_name: order === "asc" ? 1 : -1 } },
        { $skip: skip },
        { $limit: limitNum },
        {
          $project: {
            seller: { _id: 1, full_name: 1 },
            store: { _id: 1, name: 1 },
            asin: 1,
            asin_type: 1,
            platform: 1,
            psd: 1,
            template: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ];

      listings = await Listing.aggregate(pipeline);

      const listingIds = listings.map((l) => l._id).filter(Boolean);
      let salesMap = new Map();

      if (listingIds.length > 0) {
        const agg = await OrderCustomProduct.aggregate([
          { $match: { "items.listingId": { $in: listingIds } } },
          { $unwind: "$items" },
          { $match: { "items.listingId": { $in: listingIds } } },
          {
            $group: {
              _id: { listingId: "$items.listingId", orderId: "$orderId" },
            },
          },
          { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
        ]);

        salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
      }

      listings = listings.map((l) => ({
        ...l,
        total_sales: salesMap.get(String(l._id)) || 0,
      }));

    } else {
      const mongoSort = { [sort]: order === "asc" ? 1 : -1 };

      listings = await Listing.find(filter)
        .sort(mongoSort)
        .skip(skip)
        .limit(limitNum)
        .populate({ path: "seller", select: "full_name" })
        .populate({ path: "store", select: "name" })
        .lean();

      const listingIds = listings.map((l) => l._id).filter(Boolean);
      let salesMap = new Map();

      if (listingIds.length > 0) {
        const agg = await OrderCustomProduct.aggregate([
          { $match: { "items.listingId": { $in: listingIds } } },
          { $unwind: "$items" },
          { $match: { "items.listingId": { $in: listingIds } } },
          {
            $group: {
              _id: { listingId: "$items.listingId", orderId: "$orderId" },
            },
          },
          { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
        ]);

        salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
      }

      listings = listings.map((l) => ({
        ...l,
        total_sales: salesMap.get(String(l._id)) || 0,
      }));
    }

    return res.json({ total, listings, page: pageNum, perPage: limitNum });
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Error fetching listings", error: error.message });
  }
};

const getPsdStatistics = async (req, res) => {
  try {
    const {
      from,
      to,
      store,
      seller,
      platform,
      asinType,
      search,
      asinTypeMode,
    } = req.query;

    // ===== baseFilter: KHÔNG có điều kiện psd.status =====
    const baseFilter = {};

    if (from && to) {
      baseFilter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    if (store) baseFilter.store = store; // nếu là ObjectId, đổi sang new ObjectId(store)
    if (seller) baseFilter.seller = seller;
    if (platform) baseFilter.platform = platform;
    if (asinType) baseFilter.asin_type = asinType;
    if (asinTypeMode === "excludeOutline") {
      baseFilter.asin_type = { $ne: "Outline" };
    } else if (asinTypeMode === "onlyOutline") {
      baseFilter.asin_type = "Outline";
    }

    if (search) {
      const regex = new RegExp(search, "i");
      baseFilter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    // all = tất cả listing khớp baseFilter (bất kể có/không có psd, hay psd.status là gì)
    const all = await Listing.countDocuments(baseFilter);

    // pending = psd.status = 'Unavailable'
    const pending = await Listing.countDocuments({
      ...baseFilter,
      "psd.status": "Unavailable",
    });

    // complete = psd.status = 'Available'
    const complete = await Listing.countDocuments({
      ...baseFilter,
      "psd.status": "Available",
    });

    return res.json({ all, pending, complete });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Error fetching PSD statistics", error: error.message });
  }
};

function hasRole(userRole, target) {
  if (!userRole) return false;
  if (Array.isArray(userRole)) {
    return userRole.some(
      (r) => String(r).toLowerCase() === String(target).toLowerCase()
    );
  }
  return String(userRole).toLowerCase() === String(target).toLowerCase();
}

const getListingStatistics = async (req, res) => {
  try {
    const { from, to, store, seller, platform, search } = req.query;

    // ===== RBAC =====
    const role = req.user?.role;
    const userId = req.user?.userId;
    const isAdmin = hasRole(role, "Admin");
    const isSeller = hasRole(role, "Seller");

    // ===== baseFilter =====
    const baseFilter = {};

    // RBAC scoping
    if (isSeller && !isAdmin) {
      baseFilter.seller = userId; // Seller chỉ xem của mình
    } else if (seller) {
      baseFilter.seller = seller; // Admin (hoặc role khác) có thể lọc seller
    }

    // time range (createdAt)
    if (from || to) {
      baseFilter.createdAt = {};
      if (from) baseFilter.createdAt.$gte = new Date(from);
      if (to) baseFilter.createdAt.$lte = new Date(to);
    }

    if (store) baseFilter.store = store;
    if (platform) baseFilter.platform = platform;

    if (search) {
      const regex = new RegExp(search, "i");
      baseFilter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    // Tổng số listing
    const totalAsin = await Listing.countDocuments(baseFilter);

    // PSD Available
    const psdAvailable = await Listing.countDocuments({
      ...baseFilter,
      "psd.status": "Available",
    });

    // No PSD = tất cả trừ Available (không có psd hoặc status khác)
    const noPsd = await Listing.countDocuments({
      ...baseFilter,
      $or: [
        { psd: { $exists: false } },
        { "psd.status": { $ne: "Available" } },
      ],
    });

    // Anonymous Asin (chưa định nghĩa, tạm 0)
    const anonymousAsin = 0;

    // Danh sách asin_type cố định (theo UI)
    const asinTypes = [
      "First Sale",
      "Normal",
      "Outline",
      "Custom Image",
      "POD Lovers",
      "Style",
      "Tool",
      "Auto Fulfill",
      "Others",
    ];

    // Breakdown theo asin_type
    const asinTypeAgg = await Listing.aggregate([
      { $match: baseFilter },
      { $group: { _id: "$asin_type", count: { $sum: 1 } } },
    ]);

    // Map ra object kết quả với giá trị mặc định = 0
    const asinTypeCounts = {};
    for (const t of asinTypes) asinTypeCounts[t] = 0;

    for (const row of asinTypeAgg) {
      const key = row._id || "Others";
      if (asinTypeCounts.hasOwnProperty(key)) {
        asinTypeCounts[key] += row.count;
      } else {
        asinTypeCounts["Others"] += row.count; // mọi giá trị lạ dồn vào Others
      }
    }

    // All = tổng listing sau filter (ổn định nhất)
    asinTypeCounts.All = totalAsin;

    return res.json({
      totalAsin,
      anonymousAsin,
      psdAvailable,
      noPsd,
      asinTypeCounts,
    });
  } catch (error) {
    console.error(error);
    return res
      .status(500)
      .json({ message: "Error fetching PSD statistics", error: error.message });
  }
};

// ==============================
// Upsert listing
// ==============================
const upsertListing = async (req, res) => {
  try {
    const data = req.body;
    const updated = await Listing.findOneAndUpdate(
      { asin: data.asin },
      { $set: data },
      { upsert: true, new: true }
    );
    res.json(updated);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error upserting listing", error: error.message });
  }
};
const ALLOWED_EXTS = [".zip"];
const MIME_BY_EXT = {
  ".zip": "application/zip",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase();
    if (ext !== ".zip") return cb(new Error("Chỉ chấp nhận .zip"));
    cb(null, true);
  },
});
function buildDesignKeyByExt(asin, ext) {
  ext = (ext || ".psd").toLowerCase();
  // Quy ước: psd/<ASIN>/<ASIN><ext>
  return `psd/${asin}/${asin}${ext}`;
}

// ==============================
// Upload/Update PSD (overwrite theo ASIN)
// ==============================
const updatePSD = [
  upload.single("file"),
  async (req, res) => {
    try {
      const { asin } = req.params;
      const status =
        (req.body && req.body.status) === "Unavailable"
          ? "Unavailable"
          : "Available";

      if (!asin) return res.status(400).json({ message: "Thiếu asin" });
      if (!req.file?.buffer)
        return res.status(400).json({ message: "Thiếu file (field: file)" });

      // ✅ Ép chỉ .zip (fileFilter đã chặn từ trước)
      const originalName = req.file.originalname || `${asin}.zip`;
      const ext = ".zip";

      // ✅ Key theo quy ước: psd/<ASIN>/<ASIN>.zip
      const key = buildDesignKeyByExt(asin, ext);

      // ✅ MIME chuẩn .zip
      const contentType = MIME_BY_EXT[ext] || "application/zip";

      // Upload (overwrite nếu tồn tại)
      const { url } = await uploadBufferToWasabi(req.file.buffer, {
        key,
        contentType,
      });

      // Lưu metadata vào listing.psd
      const updated = await Listing.findOneAndUpdate(
        { asin },
        {
          $set: {
            "psd.psd_id": asin,
            "psd.url": url,
            "psd.status": status,
            "psd.file_name": originalName,
            "psd.file_ext": ext, // luôn '.zip'
            "psd.mime": contentType,
            "psd.size": req.file.size || null,
            "psd.archive": true, // vì .zip
            date_updated: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      return res.json({
        message: "Cập nhật file thiết kế thành công",
        file_type: "ZIP",
        key,
        listing: updated,
      });
    } catch (err) {
      console.error("Error updating design file:", err);
      return res
        .status(500)
        .json({ message: "Error updating design file", error: err.message });
    }
  },
];

// ==============================
// Lấy signed URL để download file thiết kế (PSD/ZIP/RAR)
// ==============================
const getPsdSignedUrl = async (req, res) => {
  try {
    const { asin } = req.params;
    const expires = Math.max(
      60,
      Math.min(86400, Number(req.query.expires) || 3600)
    );
    const asAttachment = String(req.query.download || "") === "1";

    const listing = await Listing.findOne({ asin }).lean();
    if (!listing)
      return res.status(404).json({ message: "Listing không tồn tại" });

    // ✅ Fallback .zip thay vì .psd
    const ext = (listing.psd?.file_ext || ".zip").toLowerCase();
    const key = buildDesignKeyByExt(asin, ext); // luôn trả psd/<ASIN>/<ASIN>.zip

    const filename = `${asin}${ext}`;
    const url = await getSignedUrlForKey(key, {
      expiresIn: expires,
      asAttachment,
      filename,
    });

    return res.json({ asin, key, signed_url: url, expires_in: expires });
  } catch (error) {
    console.error("Error getPsdSignedUrl:", error);
    return res
      .status(500)
      .json({ message: "Lỗi tạo signed URL", error: error.message });
  }
};

// ==============================
// Delete listing
// ==============================
const deleteListing = async (req, res) => {
  try {
    const { id } = req.params;
    await Listing.findOneAndDelete({ _id: id });
    res.json({ message: "Listing deleted" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error deleting listing", error: error.message });
  }
};

const updateListing = async (req, res) => {
  try {
    const { id } = req.params;
    await Listing.findByIdAndUpdate(id, req.body, { new: true });
    res.json({ message: "Listing updated" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error update listing", error: error.message });
  }
};

// ==============================
// Excel import
// ==============================
const fieldColumnMapping = {
  asin: "ASIN",
  product_image: "Image",
  total_sales: "Total Sales",
  platform: "Platform",
  store: "Store",
  seller: "Seller",
  thread_color: "Thread Color",
  thread_note: "Thread Note",
  asin_type: "ASIN Type",
  other_config: "Other Config",

  // Template group
  "template.style": "Style",
  "template.sub_style": "Sub Style",
  "template.design_product": "Design Product",
  "template.variant": "Variant",

  // PSD group
  "psd.psd_id": "PSD ID",
  "psd.status": "PSD Status",
};

const formatColumnName = (fieldName) =>
  fieldColumnMapping[fieldName] || fieldName;

const importListingsFromExcel = async (req, res) => {
  try {
    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    const listingsToInsert = [];

    for (const row of rows) {
      const asin = row[formatColumnName("asin")]?.toString().trim();
      if (!asin) continue;

      const newListing = { asin, template: {}, psd: {} };

      const topLevelFields = [
        "product_image",
        "total_sales",
        "platform",
        "store",
        "seller",
        "thread_color",
        "thread_note",
        "asin_type",
        "other_config",
      ];

      const templateFields = [
        "style",
        "sub_style",
        "design_product",
        "variant",
      ];
      const psdFields = ["psd_id", "status"];

      topLevelFields.forEach((field) => {
        const col = formatColumnName(field);
        if (row[col] !== undefined) newListing[field] = row[col];
      });

      templateFields.forEach((field) => {
        const col = formatColumnName(`template.${field}`);
        if (row[col] !== undefined) newListing.template[field] = row[col];
      });

      psdFields.forEach((field) => {
        const col = formatColumnName(`psd.${field}`);
        if (row[col] !== undefined) {
          if (field === "status") {
            newListing.psd.status =
              row[col].toLowerCase() === "available"
                ? "Available"
                : "Unavailable";
          } else {
            newListing.psd[field] = row[col];
          }
        }
      });

      newListing.template.variant ||= "All";
      newListing.psd.status ||= "Unavailable";
      newListing.platform ||= "Amazon";
      newListing.total_sales ||= 0;

      listingsToInsert.push(newListing);
    }

    console.log(`✅ Tổng bản ghi sẽ insert: ${listingsToInsert.length}`);
    if (listingsToInsert.length === 0) {
      fs.unlinkSync(filePath);
      return res
        .status(400)
        .json({ message: "Không có bản ghi hợp lệ để import" });
    }

    await Listing.insertMany(listingsToInsert, { ordered: false });
    fs.unlinkSync(filePath);

    res.json({
      message: "Import thành công",
      inserted: listingsToInsert.length,
    });
  } catch (error) {
    console.error("❌ Lỗi import:", error);
    res.status(500).json({ message: "Lỗi import", error: error.message });
  }
};

// ==============================
// Export toàn bộ ASIN + Seller + Store
// ==============================
// ==============================
// Export toàn bộ ASIN + Seller + Store + Total Sales
// ==============================
const exportAsinSellerStore = async (req, res) => {
  try {
    const {
      asinType,
      asinTypeMode,
      seller,
      platform,
      search,
      from,
      to,
      store,
    } = req.query;

    // ===== RBAC =====
    const role = req.user?.role;
    const userId = req.user?.userId;

    const isAdmin = /^admin$/i.test(role);
    const isSeller = /^seller$/i.test(role);

    const filter = {};

    if (isSeller && !isAdmin) {
      filter.seller = userId;
    } else if (seller) {
      filter.seller = seller;
    }

    // Filters giống getListings
    if (asinType) filter.asin_type = asinType;
    if (asinTypeMode === "excludeOutline") {
      filter.asin_type = { $ne: "Outline" };
    } else if (asinTypeMode === "onlyOutline") {
      filter.asin_type = "Outline";
    }

    if (platform) filter.platform = platform;
    if (store) filter.store = store;

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    if (search) {
      const regex = new RegExp(search, "i");
      filter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    // Lấy toàn bộ listing (không paging)
    const listings = await Listing.find(filter)
      .populate({ path: "seller", select: "full_name email" })
      .populate({ path: "store", select: "name" })
      .lean();

    if (!listings.length) {
      return res.json({
        message: "Không có dữ liệu để export",
        total: 0,
      });
    }

    // ===== TÍNH TOTAL SALES giống getListings =====
    const listingIds = listings.map((l) => l._id).filter(Boolean);
    let salesMap = new Map();

    if (listingIds.length > 0) {
      const agg = await OrderCustomProduct.aggregate([
        { $match: { "items.listingId": { $in: listingIds } } },
        { $unwind: "$items" },
        { $match: { "items.listingId": { $in: listingIds } } },
        {
          $group: {
            _id: { listingId: "$items.listingId", orderId: "$orderId" },
          },
        },
        { $group: { _id: "$_id.listingId", orders: { $sum: 1 } } },
      ]);

      salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
    }

    // Map ra dữ liệu Excel
    const rows = listings.map((l) => ({
      ASIN: l.asin || "",
      Platform: l.platform || "",
      "ASIN Type": l.asin_type || "",
      "Total Sales": salesMap.get(String(l._id)) || 0, // 👈 cột mới
      "Seller ID": l.seller?._id?.toString() || "",
      "Seller Name": l.seller?.full_name || "",
      "Seller Email": l.seller?.email || "",
      "Store ID": l.store?._id?.toString() || "",
      "Store Name": l.store?.name || "",
      "Created At": l.createdAt
        ? new Date(l.createdAt).toISOString().slice(0, 19).replace("T", " ")
        : "",
    }));

    // Tạo workbook Excel
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "ASINs");

    const buffer = XLSX.write(workbook, {
      bookType: "xlsx",
      type: "buffer",
    });

    const filename = `asin_seller_store_${Date.now()}.xlsx`;

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    console.error("Error exportAsinSellerStore:", error);
    return res
      .status(500)
      .json({ message: "Lỗi export ASIN", error: error.message });
  }
};



module.exports = {
  getListings,
  upsertListing,
  updatePSD,
  deleteListing,
  importListingsFromExcel,
  getPsdSignedUrl,
  getPsdStatistics,
  getListingStatistics,
  updateListing,
  exportAsinSellerStore
};
