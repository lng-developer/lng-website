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
      asinTypeMode, // excludeOutline | onlyOutline
      seller,
      platform,
      sort = "createdAt", // createdAt | updatedAt | total_sales | seller_name
      order = "desc",
      search,
      psdStatus,
      from,
      to,
      store,
    } = req.query;

    const filter = {};

    // asin_type filters
    if (asinType) filter.asin_type = asinType;
    if (asinTypeMode === "excludeOutline") {
      filter.asin_type = { $ne: "Outline" };
    } else if (asinTypeMode === "onlyOutline") {
      filter.asin_type = "Outline";
    }

    if (seller) filter.seller = seller;
    if (platform) filter.platform = platform;
    if (store) filter.store = store;

    // psd.status (1 hoặc nhiều)
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

    // date range cho listing (createdAt)
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    // search theo asin hoặc template.design_product
    if (search) {
      const regex = new RegExp(search, "i");
      filter.$or = [{ asin: regex }, { "template.design_product": regex }];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(perPage, 10) || 10, 1);
    const skip = (pageNum - 1) * limitNum;

    const total = await Listing.countDocuments(filter);

    // sort trên Listing (trừ seller_name và total_sales sẽ xử lý sau)
    const mongoSort =
      sort === "seller_name" || sort === "total_sales"
        ? { createdAt: order === "asc" ? 1 : -1 } // tạm thời; sẽ resort trong memory
        : { [sort]: order === "asc" ? 1 : -1 };

    let listings = await Listing.find(filter)
      .sort(mongoSort)
      .skip(skip)
      .limit(limitNum)
      .populate({ path: "seller", select: "full_name" })
      .populate({ path: "store", select: "name" })
      .lean();

    // ===== TÍNH total_sales CHO CÁC LISTING TRONG TRANG HIỆN TẠI =====
    const listingIds = listings.map((l) => l._id).filter(Boolean);
    let salesMap = new Map();

    if (listingIds.length > 0) {
      const agg = await OrderCustomProduct.aggregate([
        // chỉ lấy các đơn có ít nhất 1 item có listingId trong danh sách
        { $match: { "items.listingId": { $in: listingIds } } },
        { $unwind: "$items" },
        { $match: { "items.listingId": { $in: listingIds } } },
        // gom theo (listingId, orderId) để mỗi order chỉ được tính 1 lần cho mỗi listing
        {
          $group: {
            _id: { listingId: "$items.listingId", orderId: "$orderId" },
          },
        },
        // đếm số order duy nhất cho từng listingId
        {
          $group: {
            _id: "$_id.listingId",
            orders: { $sum: 1 },
          },
        },
      ]);

      salesMap = new Map(agg.map((x) => [String(x._id), x.orders]));
    }

    // gán total_sales vào từng listing
    listings = listings.map((l) => ({
      ...l,
      total_sales: salesMap.get(String(l._id)) || 0,
    }));

    // ===== RESORT TRONG MEMORY (nếu cần) =====
    if (sort === "seller_name") {
      listings.sort((a, b) => {
        const A = (a.seller?.full_name || "").toString();
        const B = (b.seller?.full_name || "").toString();
        return order === "asc" ? A.localeCompare(B) : B.localeCompare(A);
      });
    } else if (sort === "total_sales") {
      listings.sort((a, b) =>
        order === "asc"
          ? a.total_sales - b.total_sales
          : b.total_sales - a.total_sales
      );
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

const getListingStatistics = async (req, res) => {
  try {
    const { from, to, store, seller, platform, search } = req.query;

    // ===== baseFilter =====
    const baseFilter = {};

    if (from && to) {
      baseFilter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
    }

    if (store) baseFilter.store = store;
    if (seller) baseFilter.seller = seller;
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

    // No PSD = tất cả trừ Available
    const noPsd = await Listing.countDocuments({
      ...baseFilter,
      $or: [
        { psd: { $exists: false } },
        { "psd.status": { $ne: "Available" } },
      ],
    });

    // Anonymous Asin (mặc định 0)
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
    const asinTypeCounts = { All: 0 }; // thêm All
    for (const type of asinTypes) {
      asinTypeCounts[type] = 0;
    }

    for (const row of asinTypeAgg) {
      const key = row._id || "others"; // nếu null thì đưa vào Others
      if (asinTypeCounts.hasOwnProperty(key)) {
        asinTypeCounts[key] = row.count;
      } else {
        asinTypeCounts["others"] += row.count; // cái nào không map thì dồn vào Others
      }
      asinTypeCounts.All += row.count; // cộng dồn cho All
    }

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

// ==============================
// Multer config (nhận PSD qua RAM)
// ==============================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "image/vnd.adobe.photoshop" ||
      /\.psd$/i.test(file.originalname);
    if (!ok) return cb(new Error("Chỉ chấp nhận PSD"));
    cb(null, true);
  },
});

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
        return res
          .status(400)
          .json({ message: "Thiếu file PSD (field: file)" });

      // Key cố định theo ASIN: psd/<ASIN>/<ASIN>.psd
      const key = buildPsdKeyFromAsin(asin);

      // Upload (overwrite nếu tồn tại)
      const { url } = await uploadBufferToWasabi(req.file.buffer, {
        key,
        contentType: "image/vnd.adobe.photoshop",
      });

      const updated = await Listing.findOneAndUpdate(
        { asin },
        {
          $set: {
            "psd.psd_id": asin, // trùng ASIN
            "psd.url": url, // với bucket private, URL này không tải trực tiếp; dùng signed URL để tải
            "psd.status": status,
            date_updated: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      return res.json({ message: "Cập nhật PSD thành công", listing: updated });
    } catch (err) {
      console.error("Error updating PSD:", err);
      return res
        .status(500)
        .json({ message: "Error updating PSD", error: err.message });
    }
  },
];

// ==============================
// Lấy signed URL để download PSD
// ==============================
const getPsdSignedUrl = async (req, res) => {
  try {
    const { asin } = req.params;
    const expires = Math.max(
      60,
      Math.min(86400, Number(req.query.expires) || 3600)
    ); // 1m–24h
    const asAttachment = String(req.query.download || "") === "1";

    const listing = await Listing.findOne({ asin }).lean();
    if (!listing)
      return res.status(404).json({ message: "Listing không tồn tại" });

    // ✅ luôn build key từ ASIN theo quy ước lưu file
    const key = buildPsdKeyFromAsin(asin);

    const filename = `${asin}${path.extname(key) || ".psd"}`;
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
};
