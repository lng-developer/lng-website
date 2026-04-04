const db = require("../models");
const ShippingBatch = db.ShippingBatch;
const OrderCustomProduct = db.orderCustomProduct;

async function getRealTrackingForOrder(orderId) {
  const order = await OrderCustomProduct.findOne({ orderId: orderId });
  return order?.items[0]?.tracking_info?.tracking || null;
}

/**
 * TODO: Hàm gen tracking fake cho 1 order
 * Bạn tự thay logic cho phù hợp.
 */
function generateFakeTracking() {
  let tracking = "92";

  // Thêm 18 chữ số ngẫu nhiên còn lại (tổng cộng 20 chữ số)
  for (let i = 0; i < 18; i++) {
    tracking += Math.floor(Math.random() * 10);
  }

  return tracking;
}

/**
 * Build nội dung file confirm / update
 * format: orderId|tracking
 */
function buildPlainTextFile(rows) {
  let content = "orderId|tracking\n";
  for (const row of rows) {
    content += `${row.orderId}|${row.tracking}\n`;
  }
  return content;
}

function parseOrdersWithDaysFromTxt(fileBuffer) {
  const raw = fileBuffer.toString("utf8");

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const headerLine = lines[0];
  const delimiter = "\t"; // Amazon report: TAB-separated

  const headers = headerLine
    .split(delimiter)
    .map((h) => h.trim().toLowerCase());

  const orderIdIndex = headers.findIndex(
    (h) => h === "order-id" || h === '"order-id"',
  );
  const daysPastPromiseIndex = headers.findIndex(
    (h) => h === "days-past-promise" || h === '"days-past-promise"',
  );

  if (orderIdIndex === -1) {
    throw new Error("Không tìm thấy cột 'order-id' trong file TXT");
  }
  if (daysPastPromiseIndex === -1) {
    throw new Error("Không tìm thấy cột 'days-past-promise' trong file TXT");
  }

  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const cols = line.split(delimiter);
    const orderId = (cols[orderIdIndex] || "").trim();
    const daysStr = (cols[daysPastPromiseIndex] || "").trim();

    if (!orderId) continue;

    const daysPastPromise = Number(daysStr);

    rows.push({ orderId, daysPastPromise });
  }

  return rows;
}

const createBatchFromFile = async (req, res, next) => {
  try {
    const { machineId, label } = req.body;
    const file = req.file; // multer gắn vào

    if (!file) {
      return res
        .status(400)
        .json({ message: "Missing file TXT (field: file)" });
    }
    if (!machineId || !label) {
      return res
        .status(400)
        .json({ message: "machineId and label are required" });
    }

    // 1) Parse file: lấy orderId + days-past-promise
    const rows = parseOrdersWithDaysFromTxt(file.buffer);
    if (!rows.length) {
      return res.status(400).json({ message: "No valid rows found in file" });
    }

    // 2) Lọc: chỉ lấy days-past-promise = -2 và unique orderId
    const orderIds = [];
    const seen = new Set();

    for (const row of rows) {
      if (row.daysPastPromise !== -2) continue;
      const id = row.orderId;
      if (!id || seen.has(id)) continue; // bỏ trùng
      seen.add(id);
      orderIds.push(id);
    }

    if (!orderIds.length) {
      return res.status(400).json({
        message: "No orderId with days-past-promise = -2 found in file",
      });
    }

    const completed = [];
    const tracking_fakes = [];

    // 3) Với mỗi orderId đã lọc: chỉ xử lý đơn có real tracking
    for (const orderId of orderIds) {
      const realTracking = await getRealTrackingForOrder(orderId);

      if (realTracking) {
        // Đơn có tracking thật trong hệ thống
        completed.push({
          orderId,
          tracking: realTracking,
          isFake: false,
          source: "system",
        });
      } else {
        // Đơn chưa có tracking -> chỉ lưu vào tracking_fakes để theo dõi, không tạo fake tracking
        tracking_fakes.push({
          orderId,
          note: "no real tracking available",
        });
      }
    }

    // 4) Stats
    const stats = {
      totalOrders: completed.length + tracking_fakes.length,
      totalReal: completed.length, // chỉ đơn có real tracking
      totalFake: tracking_fakes.length, // đơn không có tracking
    };

    // 5) Tạo record batch
    const fileName = `confirm_${machineId}_${Date.now()}.txt`;

    const batch = await ShippingBatch.create({
      machineId,
      label,
      type: "CONFIRM",
      fileName,
      status: "CONFIRM_FILE_READY",
      completed,
      tracking_fakes,
      stats,
    });

    // 6) Build file confirm ship từ "completed"
    const rowsForFile = completed.map((r) => ({
      orderId: r.orderId,
      tracking: r.tracking,
    }));
    const confirmFileContent = buildPlainTextFile(rowsForFile);

    return res.status(201).json({
      batchId: batch._id,
      machineId: batch.machineId,
      label: batch.label,
      status: batch.status,
      fileName: batch.fileName,
      stats: batch.stats,
      confirmFileContent,
    });
  } catch (err) {
    next(err);
  }
};

const listShippingBatches = async (req, res, next) => {
  try {
    const {
      machineId,
      label,
      status,
      fromDate,
      toDate,
      limit = 50,
    } = req.query;

    const filter = {};

    // Filter machineId
    if (machineId) filter.machineId = machineId;

    // Filter label
    if (label) filter.label = label;

    // Filter status
    if (status) filter.status = status;

    // Filter theo createdAt (khoảng thời gian)
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) {
        const from = new Date(fromDate);
        if (!isNaN(from.getTime())) filter.createdAt.$gte = from;
      }
      if (toDate) {
        const to = new Date(toDate);
        if (!isNaN(to.getTime())) filter.createdAt.$lte = to;
      }
    }

    // Query DB
    const batches = await ShippingBatch.find(filter)
      .sort({ createdAt: -1 }) // batch mới nhất đứng đầu
      .limit(Number(limit)); // default 50

    // Format response gọn nhẹ
    const response = batches.map((b) => ({
      batchId: b._id,
      machineId: b.machineId,
      label: b.label,
      status: b.status,
      createdAt: b.createdAt,
      fileName: b.fileName,
      stats: b.stats,
      completed: b.completed,
      tracking_fakes: b.tracking_fakes,
      type: b.type,
      confirmShipDate: b.confirmShipDate || "",
    }));

    return res.json({
      total: response.length,
      batches: response,
    });
  } catch (err) {
    next(err);
  }
};

const createUpdateBatchFromSystem = async (req, res, next) => {
  try {
    const { batchId } = req.params;

    const original = await ShippingBatch.findById(batchId);
    if (!original) {
      return res.status(404).json({ message: "Original batch not found" });
    }

    // Nếu không còn fake nào thì khỏi tạo batch update
    if (!original.tracking_fakes || original.tracking_fakes.length === 0) {
      return res
        .status(400)
        .json({ message: "No fake tracking to update in this batch" });
    }

    const resolvedItems = []; // các đơn đã tìm được tracking thật (cho batch mới)
    const remainingFakes = []; // những đơn vẫn chưa có tracking thật, giữ lại trong batch gốc

    // 1) Duyệt từng đơn fake trong batch gốc
    for (const fakeItem of original.tracking_fakes) {
      const { orderId, tracking: fakeTracking } = fakeItem;

      // pull tracking thật từ hệ thống bạn (thêm machineId/label nếu cần)
      const realTracking = await getRealTrackingForOrder(orderId);

      if (realTracking) {
        // ĐÃ CÓ TRACKING THẬT -> thêm vào danh sách update
        resolvedItems.push({
          orderId,
          tracking: realTracking,
          isFake: false,
          source: "system",
        });

        // Đồng thời update trong original.completed: đổi từ fake -> real
        const comp = original.completed.find((c) => c.orderId === orderId);
        if (comp) {
          comp.tracking = realTracking;
          comp.isFake = false;
          comp.source = "system";
        }
      } else {
        // VẪN CHƯA CÓ TRACKING -> giữ lại trong fake list gốc
        remainingFakes.push(fakeItem);
      }
    }

    // 2) Nếu không order nào có real -> không tạo batch mới, không đụng batch gốc
    if (resolvedItems.length === 0) {
      return res.status(200).json({
        message: "No real tracking found for fake orders in this batch",
        updateBatchCreated: false,
        originalBatchId: original._id,
        remainingFakeCount: original.tracking_fakes.length,
      });
    }

    // 3) Cập nhật lại fake list + stats cho batch gốc
    original.tracking_fakes = remainingFakes;
    original.stats.totalOrders = original.completed.length;
    original.stats.totalFake = original.completed.filter(
      (c) => c.isFake,
    ).length;
    original.stats.totalReal = original.completed.filter(
      (c) => !c.isFake,
    ).length;

    await original.save();

    // 4) Tạo batch mới type UPDATE_FAKE cho những đơn đã có real tracking
    const updateFileName = `update_${original.machineId}_${Date.now()}.txt`;

    const updateBatch = await ShippingBatch.create({
      machineId: original.machineId,
      label: original.label,
      confirmShipDate: original.createdAt,
      type: "UPDATE_FAKE",
      fileName: updateFileName,
      status: "CONFIRM_FILE_READY",
      completed: resolvedItems, // batch update chỉ chứa các đơn cần update
      tracking_fakes: [], // batch update không chứa fake
      stats: {
        totalOrders: resolvedItems.length,
        totalFake: 0,
        totalReal: resolvedItems.length,
      },
    });

    // 5) Build file update để gửi Amazon (chỉ các đơn vừa resolved)
    const rows = resolvedItems.map((r) => ({
      orderId: r.orderId,
      tracking: r.tracking,
    }));
    const updateFileContent = buildPlainTextFile(rows);

    return res.status(201).json({
      updateBatchCreated: true,
      updateBatchId: updateBatch._id,
      originalBatchId: original._id,
      machineId: updateBatch.machineId,
      label: updateBatch.label,
      status: updateBatch.status,
      fileName: updateBatch.fileName,
      stats: updateBatch.stats,
      updateFileContent, // FE/extension dùng string này để tải file update
      remainingFakeCount: remainingFakes.length, // số đơn vẫn còn fake trong batch gốc
    });
  } catch (err) {
    next(err);
  }
};

function buildShipDateString(baseDate) {
  // baseDate: Date hoặc string, nếu không truyền thì dùng today
  const ref = baseDate ? new Date(baseDate) : new Date();

  const shipDate = new Date(
    Date.UTC(
      ref.getUTCFullYear(),
      ref.getUTCMonth(),
      ref.getUTCDate(),
      0,
      22,
      22,
    ),
  );

  return shipDate.toISOString().replace(".000Z", "+00:00");
}

// Chuẩn hóa field để bỏ khoảng trắng, dấu " và dấu , ở cuối
function normalizeField(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim() // bỏ khoảng trắng 2 đầu
    .replace(/^"+|"+$/g, "") // bỏ " ở đầu/cuối nếu có
    .replace(/,+$/g, ""); // bỏ dấu phẩy ở cuối (case "9214...,")
}

function buildCompletedShippingFile(completed, options = {}) {
  const {
    carrierCode = "USPS",
    shipMethod = "USPS First Class",
    shipDate, // đã build sẵn ở ngoài
  } = options;

  let content =
    "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

  for (const item of completed) {
    if (!item.orderId || !item.tracking) continue;

    const orderId = normalizeField(item.orderId);
    const tracking = normalizeField(item.tracking);

    if (!orderId || !tracking) continue;

    let finalCarrierCode = carrierCode;
    let finalShipMethod = shipMethod;

    if (tracking.startsWith("UK")) {
      finalCarrierCode = "Yanwen";
      finalShipMethod = "Yanwen Air Economy Mail General";
    }

    if (tracking.startsWith("UL")) {
      finalCarrierCode = "Yanwen";
      finalShipMethod = "Yanwen Air Economy Mail General";
    }

    if (tracking.startsWith("YT")) {
      finalCarrierCode = "Yun Express";
      finalShipMethod = "YunExpress Global Direct line (standard )-Tracked";
    }


    content += [
      orderId,
      shipDate,
      finalCarrierCode,
      tracking,
      finalShipMethod,
    ].join("\t");

    content += "\n";
  }

  return content;
}

const downloadCompletedFile = async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { carrierCode, shipMethod, shipDate } = req.query;

    const batch = await ShippingBatch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ message: "Batch not found" });
    }

    if (!batch.completed || batch.completed.length === 0) {
      return res
        .status(400)
        .json({ message: "No completed data to export for this batch" });
    }

    // ✅ Xác định base date để build ship-date
    let shipDateBase;

    if (shipDate) {
      // FE truyền custom shipDate (ưu tiên cao nhất)
      const d = new Date(shipDate);
      if (isNaN(d.getTime())) {
        return res
          .status(400)
          .json({ message: "shipDate is invalid date format" });
      }
      shipDateBase = d;
    } else {
      // Không truyền → luôn dùng ngày tạo batch
      shipDateBase = batch.createdAt ? new Date(batch.createdAt) : new Date();
    }

    const shipDateStr = buildShipDateString(shipDateBase);

    const fileContent = buildCompletedShippingFile(batch.completed, {
      carrierCode,
      shipMethod,
      shipDate: shipDateStr,
    });

    const filename =
      batch.fileName ||
      (batch.type === "UPDATE_FAKE"
        ? `update_confirmShip_${batch._id}.txt`
        : `confirmShip_${batch._id}.txt`);

    res
      .status(200)
      .set("Content-Type", "text/tab-separated-values; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${filename}"`)
      .send(fileContent);
  } catch (err) {
    next(err);
  }
};

function buildGlobalUpdateFile(rows, options = {}) {
  const { carrierCode = "USPS", shipMethod = "USPS First Class" } = options;

  let content =
    "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

  for (const row of rows) {
    content += [
      row.orderId,
      row.shipDate,
      carrierCode,
      row.tracking,
      shipMethod,
    ].join("\t");

    content += "\n";
  }

  return content;
}

const updateAllFakeTracking = async (req, res, next) => {
  try {
    const { machineId } = req.body;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    // 1️⃣ Lấy tất cả CONFIRM batch còn fake
    const confirmBatches = await ShippingBatch.find({
      type: "CONFIRM",
      machineId,
      tracking_fakes: { $exists: true, $ne: [] },
    });

    if (!confirmBatches.length) {
      return res.status(200).json({
        message: "No fake tracking found in confirm batches",
      });
    }

    const resolvedItems = [];

    // 2️⃣ Duyệt từng CONFIRM batch
    for (const batch of confirmBatches) {
      const remainingFakes = [];

      for (const fakeItem of batch.tracking_fakes) {
        const orderId = fakeItem.orderId;

        // Pull tracking real từ hệ thống
        const realTracking = await getRealTrackingForOrder(orderId);

        if (realTracking) {
          // ✅ Đã có tracking real → đưa vào batch UPDATE_GLOBAL
          resolvedItems.push({
            orderId,
            tracking: realTracking,
            sourceConfirmBatchId: batch._id, // 🔥 để xác định ship-date khi download
          });

          // Update completed trong CONFIRM batch
          const comp = batch.completed.find((c) => c.orderId === orderId);
          if (comp) {
            comp.tracking = realTracking;
            comp.isFake = false;
            comp.source = "system";
          }
        } else {
          // ❌ Chưa có → giữ lại fake
          remainingFakes.push(fakeItem);
        }
      }

      // 3️⃣ Update lại batch CONFIRM
      batch.tracking_fakes = remainingFakes;
      batch.stats.totalFake = remainingFakes.length;
      batch.stats.totalReal = batch.completed.length - remainingFakes.length;

      await batch.save();
    }

    if (!resolvedItems.length) {
      return res.status(200).json({
        message: "No fake orders have real tracking yet",
      });
    }

    // 4️⃣ Tạo batch UPDATE_GLOBAL
    const updateBatch = await ShippingBatch.create({
      machineId,
      type: "UPDATE_GLOBAL",
      status: "CONFIRM_FILE_READY",
      completed: resolvedItems,
      tracking_fakes: [],
      stats: {
        totalOrders: resolvedItems.length,
        totalFake: 0,
        totalReal: resolvedItems.length,
      },
    });

    return res.status(201).json({
      updateBatchId: updateBatch._id,
      totalUpdatedOrders: resolvedItems.length,
    });
  } catch (err) {
    next(err);
  }
};

const downloadAllUpdatedFakeFile = async (req, res, next) => {
  try {
    const {
      machineId,
      batchId,
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
    } = req.query;

    // 1. Lấy batch UPDATE_GLOBAL
    const updateBatch = await ShippingBatch.findById(batchId).lean();
    if (!updateBatch || updateBatch.type !== "UPDATE_GLOBAL") {
      return res.status(404).json({ message: "UPDATE_GLOBAL batch not found" });
    }

    if (!updateBatch.completed || updateBatch.completed.length === 0) {
      return res
        .status(400)
        .json({ message: "No data in UPDATE_GLOBAL batch" });
    }

    // 2. Gom tất cả orderId cần tra
    const orderIds = [
      ...new Set(updateBatch.completed.map((i) => String(i.orderId))),
    ];

    // 3. Tra CONFIRM batch cho từng orderId → lấy createdAt
    const confirmMatches = await ShippingBatch.aggregate([
      {
        $match: {
          type: "CONFIRM",
          machineId,
          "completed.orderId": { $in: orderIds },
        },
      },
      { $unwind: "$completed" },
      {
        $match: {
          "completed.orderId": { $in: orderIds },
        },
      },
      {
        $group: {
          _id: "$completed.orderId",
          confirmCreatedAt: { $first: "$createdAt" },
        },
      },
    ]);

    if (!confirmMatches.length) {
      return res.status(400).json({
        message: "No matching CONFIRM batch found for orders",
      });
    }

    const confirmDateMap = new Map();
    for (const row of confirmMatches) {
      confirmDateMap.set(
        String(row._id),
        buildShipDateString(row.confirmCreatedAt),
      );
    }

    // 4. Build file – carrier theo tracking prefix
    let content =
      "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

    let total = 0;

    for (const item of updateBatch.completed) {
      const orderId = String(item.orderId).trim();
      const tracking = String(item.tracking || "").trim();

      const shipDate = confirmDateMap.get(orderId);
      if (!shipDate || !tracking) continue;

      let finalCarrierCode = carrierCode;
      let finalShipMethod = shipMethod;

      if (tracking.startsWith("UK")) {
        finalCarrierCode = "Yanwen";
        finalShipMethod = "Yanwen Air Economy Mail General";
      }

      if (tracking.startsWith("UL")) {
        finalCarrierCode = "Yanwen";
        finalShipMethod = "Yanwen Air Economy Mail General";
      }

      if (tracking.startsWith("YT")) {
        finalCarrierCode = "Yun Express";
        finalShipMethod = "YunExpress Global Direct Line";
      }



      content += [
        orderId,
        shipDate,
        finalCarrierCode,
        tracking,
        finalShipMethod,
      ].join("\t");

      content += "\n";
      total++;
    }

    if (total === 0) {
      return res.status(400).json({
        message: "No valid rows to export after mapping confirm dates",
      });
    }

    const filename = `update_all_fake_${batchId}.txt`;

    return res
      .status(200)
      .set("Content-Type", "text/tab-separated-values; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${filename}"`)
      .send(content);
  } catch (err) {
    next(err);
  }
};

/**
 * Flow mới: Query DB các orders có tracking và export ra file txt ngay lập tức
 * POST /api/shipping-batch/export-orders-with-tracking
 */
const exportOrdersWithTracking = async (req, res, next) => {
  try {
    const {
      machineId,
      label = "Direct Export",
      limit = 1000,
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
      fromDate,
      toDate,
      status = ["New", "Processing", "Shipped"], // default statuses
    } = req.body;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    // 1. Build query filter
    const filter = {
      status: { $in: Array.isArray(status) ? status : [status] },
      "items.tracking_info.tracking": { $exists: true, $ne: "", $ne: null },
    };

    // Filter theo ngày tạo nếu có
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) {
        const from = new Date(fromDate);
        if (!isNaN(from.getTime())) filter.createdAt.$gte = from;
      }
      if (toDate) {
        const to = new Date(toDate);
        if (!isNaN(to.getTime())) filter.createdAt.$lte = to;
      }
    }

    // 2. Query orders có tracking
    const orders = await OrderCustomProduct.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();

    if (!orders.length) {
      return res.status(404).json({
        message: "No orders with tracking found",
        filter,
      });
    }

    // 3. Extract orders có tracking hợp lệ
    const validOrders = [];
    const shipDate = buildShipDateString(); // dùng current date

    for (const order of orders) {
      const orderId = order.orderId;
      if (!orderId) continue;

      // Lấy tracking từ item đầu tiên có tracking
      let tracking = "";
      for (const item of order.items || []) {
        const itemTracking = normalizeField(item?.tracking_info?.tracking);
        if (itemTracking && itemTracking !== "-" && itemTracking !== "---") {
          tracking = itemTracking;
          break;
        }
      }

      if (tracking) {
        validOrders.push({
          orderId: normalizeField(orderId),
          tracking,
          createdAt: order.createdAt,
        });
      }
    }

    if (!validOrders.length) {
      return res.status(404).json({
        message: "No orders with valid tracking found",
        totalScanned: orders.length,
      });
    }

    // 4. Build file content
    let content =
      "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

    for (const order of validOrders) {
      let finalCarrierCode = carrierCode;
      let finalShipMethod = shipMethod;

      // Auto-detect carrier từ tracking prefix
      if (order.tracking.startsWith("UK")) {
        finalCarrierCode = "Yanwen";
        finalShipMethod = "Yanwen Air Economy Mail General";
      } else if (order.tracking.startsWith("YT")) {
        finalCarrierCode = "Yun Express";
        finalShipMethod = "YunExpress Global Direct line (standard )-Tracked";
      }

      content += [
        order.orderId,
        shipDate,
        finalCarrierCode,
        order.tracking,
        finalShipMethod,
      ].join("\t");

      content += "\n";
    }

    // 5. Tạo batch record để tracking (optional)
    const batch = await ShippingBatch.create({
      machineId,
      label,
      type: "DIRECT_EXPORT",
      fileName: `direct_export_${machineId}_${Date.now()}.txt`,
      status: "COMPLETED",
      completed: validOrders.map(o => ({
        orderId: o.orderId,
        tracking: o.tracking,
        isFake: false,
        source: "direct_query",
      })),
      tracking_fakes: [],
      stats: {
        totalOrders: validOrders.length,
        totalReal: validOrders.length,
        totalFake: 0,
      },
    });

    // 6. Return file content
    const filename = `export_orders_tracking_${Date.now()}.txt`;

    return res
      .status(200)
      .set("Content-Type", "text/tab-separated-values; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${filename}"`)
      .send(content);

  } catch (err) {
    next(err);
  }
};

/**
 * API kiểm tra trạng thái orders: có tracking và đã đẩy lên Amazon
 * GET /api/shipping-batch/check-orders-status
 */
const checkOrdersStatus = async (req, res, next) => {
  try {
    const {
      machineId,
      limit = 1000,
      fromDate,
      toDate,
      status = ["New", "Processing", "Shipped"],
      filterType = "all", // "all", "with-tracking", "without-tracking", "submitted", "not-submitted"
    } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    // 1. Build query filter cho orders
    const orderFilter = {
      status: { $in: Array.isArray(status) ? status : [status] },
    };

    // Filter theo ngày tạo nếu có
    if (fromDate || toDate) {
      orderFilter.createdAt = {};
      if (fromDate) {
        const from = new Date(fromDate);
        if (!isNaN(from.getTime())) orderFilter.createdAt.$gte = from;
      }
      if (toDate) {
        const to = new Date(toDate);
        if (!isNaN(to.getTime())) orderFilter.createdAt.$lte = to;
      }
    }

    // 2. Query tất cả orders theo filter
    const allOrders = await OrderCustomProduct.find(orderFilter)
      .populate('shopId', 'name store') // ✅ Populate shop info
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();

    if (!allOrders.length) {
      return res.json({
        orders: [],
        totalCount: 0,
        filter: {
          machineId,
          limit: Number(limit),
          fromDate,
          toDate,
          status: Array.isArray(status) ? status : [status],
          filterType,
        },
      });
    }

    // 3. Phân loại và build chi tiết orders
    const ordersWithDetails = [];

    for (const order of allOrders) {
      let hasValidTracking = false;
      let tracking = "";
      let trackingInfo = null;

      // Kiểm tra tracking trong items
      for (const item of order.items || []) {
        const itemTracking = normalizeField(item?.tracking_info?.tracking);
        if (itemTracking && itemTracking !== "-" && itemTracking !== "---") {
          hasValidTracking = true;
          tracking = itemTracking;
          trackingInfo = {
            tracking: itemTracking,
            fulfillment: item.tracking_info?.fulfillment || "",
            status: item.tracking_info?.status || "",
            carrier: item.tracking_info?.note || "",
            updated_at: item.tracking_info?.updated_at || null,
          };
          break;
        }
      }

      ordersWithDetails.push({
        orderId: order.orderId,
        shopId: order.shopId?._id || order.shopId, // ✅ Handle populated vs non-populated
        shopName: order.shopId?.name || null, // ✅ Thêm shop name
        shopStore: order.shopId?.store || null, // ✅ Thêm shop store (seller ID)
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        hasTracking: hasValidTracking,
        tracking: tracking || null,
        trackingInfo: trackingInfo,
        itemsCount: (order.items || []).length,
        // Thêm thông tin khác nếu cần
        customerEmail: order.customer?.email || null,
        totalAmount: order.total_amount || 0,
      });
    }

    // 4. Kiểm tra orders nào đã được submit lên Amazon
    const allOrderIds = ordersWithDetails.map(o => o.orderId);
    
    const submittedBatches = await ShippingBatch.find({
      machineId,
      "completed.orderId": { $in: allOrderIds },
    }).lean();

    // Tạo Map để track submission info
    const submissionMap = new Map();
    for (const batch of submittedBatches) {
      for (const completed of batch.completed || []) {
        if (allOrderIds.includes(completed.orderId)) {
          submissionMap.set(completed.orderId, {
            submittedToAmazon: true,
            batchId: batch._id,
            batchType: batch.type,
            submittedAt: batch.createdAt,
            batchLabel: batch.label,
          });
        }
      }
    }

    // 5. Merge submission info vào orders
    const finalOrders = ordersWithDetails.map(order => ({
      ...order,
      submittedToAmazon: submissionMap.has(order.orderId),
      submissionInfo: submissionMap.get(order.orderId) || null,
    }));

    // 6. Apply filterType để lọc kết quả
    let filteredOrders = finalOrders;
    
    switch (filterType) {
      case "with-tracking":
        filteredOrders = finalOrders.filter(o => o.hasTracking);
        break;
      case "without-tracking":
        filteredOrders = finalOrders.filter(o => !o.hasTracking);
        break;
      case "submitted":
        filteredOrders = finalOrders.filter(o => o.submittedToAmazon);
        break;
      case "not-submitted":
        filteredOrders = finalOrders.filter(o => o.hasTracking && !o.submittedToAmazon);
        break;
      case "all":
      default:
        filteredOrders = finalOrders;
        break;
    }

    // 7. Tính toán summary statistics cho reference
    const stats = {
      totalScanned: allOrders.length,
      totalWithTracking: finalOrders.filter(o => o.hasTracking).length,
      totalWithoutTracking: finalOrders.filter(o => !o.hasTracking).length,
      totalSubmitted: finalOrders.filter(o => o.submittedToAmazon).length,
      totalNotSubmitted: finalOrders.filter(o => o.hasTracking && !o.submittedToAmazon).length,
      filteredCount: filteredOrders.length,
    };

    return res.json({
      orders: filteredOrders,
      totalCount: filteredOrders.length,
      stats, // Thống kê tham khảo
      filter: {
        machineId,
        limit: Number(limit),
        fromDate,
        toDate,
        status: Array.isArray(status) ? status : [status],
        filterType,
      },
    });

  } catch (err) {
    next(err);
  }
};

module.exports = {
  createBatchFromFile,
  listShippingBatches,
  createUpdateBatchFromSystem,
  downloadCompletedFile,
  updateAllFakeTracking,
  downloadAllUpdatedFakeFile,
  exportOrdersWithTracking,
  checkOrdersStatus, // ✅ Thêm function mới
};
