const db = require("../models");
const ShippingBatch = db.ShippingBatch;
const OrderCustomProduct = db.orderCustomProduct;
const Shop = db.shop;
const ExtensionTask = db.ExtensionTask;
const RealtimeLog = db.RealtimeLog;
const { emitTaskToMachine, buildTaskId } = require("../lib/taskEmitter");
const { Types } = require("mongoose");
const {
  amazonUsDate,
  carrierFromTrackingInfo,
  evaluateAmazonConfirmationEligibility,
  normalizeField,
} = require("../service/amazonConfirmationEligibility.service");
const {
  markAmazonConfirmationSubmitted,
  releaseAmazonConfirmationReservation,
  reserveAmazonConfirmation,
} = require("../service/amazonConfirmationReservation.service");

const downloadAmazonFeedReport = async (req, res, next) => {
  try {
    const batch = await ShippingBatch.findById(req.params.batchId);
    const reportText = batch?.amazonFeed?.reportText;
    if (!reportText) return res.status(404).json({ ok: false, message: "Amazon Processing Report not found" });

    const amazonBatchId = String(batch.amazonFeed.amazonBatchId || batch._id);
    return res
      .type("text/plain")
      .attachment(`amazon-processing-report-${amazonBatchId}.txt`)
      .send(reportText);
  } catch (error) {
    next(error);
  }
};

async function getRealTrackingForOrder(orderId) {
  const order = await OrderCustomProduct.findOne({ orderId: orderId });
  return order?.items[0]?.tracking_info?.tracking || null;
}

/**
 * TODO: Hàm gen tracking fake cho 1 order (COMMENTED OUT - removed fake tracking)
 * Bạn tự thay logic cho phù hợp.
 */
/*
function generateFakeTracking() {
  let tracking = "92";

  // Thêm 18 chữ số ngẫu nhiên còn lại (tổng cộng 20 chữ số)
  for (let i = 0; i < 18; i++) {
    tracking += Math.floor(Math.random() * 10);
  }

  return tracking;
}
*/

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
      amazonFeed: b.amazonFeed || {},
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

    // ✅ 6) Tự động gửi task UPLOAD_TRACKING cho extension khi có real tracking
    try {
      const io = req.app.get("io");
      if (io && resolvedItems.length > 0) {
        console.log(`🔄 [AUTO] Preparing UPLOAD_TRACKING task for batch update: ${resolvedItems.length} real tracking updates...`);

        // Tạo file content chuẩn cho upload
        const shipDateStr = buildShipDateString(original.createdAt || new Date());
        const fileContent = buildCompletedShippingFile(resolvedItems, {
          carrierCode: "USPS",
          shipMethod: "USPS First Class",
          shipDate: shipDateStr,
        });

        const filename = updateFileName;

        const taskPayload = {
          batchId: updateBatch._id,
          machineId: original.machineId,
          label: original.label,
          trackingData: resolvedItems.map(item => ({
            orderId: item.orderId,
            tracking: item.tracking,
            isFake: false,
            source: 'system'
          })),
          stats: updateBatch.stats,

          // ✅ File information - Extension sẽ nhận file content sẵn sàng upload
          file: {
            filename,
            content: fileContent,
            contentType: "text/tab-separated-values; charset=utf-8",
            size: Buffer.byteLength(fileContent, 'utf8')
          },

          uploadParams: {
            carrierCode: "USPS",
            shipMethod: "USPS First Class",
            shipDate: shipDateStr
          },

          autoGenerated: true,
          reason: "batch_update_real_tracking",
          originalBatchId: original._id,
          timestamp: new Date().toISOString()
        };

        // 🎯 Gửi cho extension của machineId này (persist + taskId tự động)
        await emitTaskToMachine(io, {
          type: "UPLOAD_TRACKING",
          shopId: original.shopId || null,
          machineId: original.machineId,
          payload: taskPayload,
        });

        // ✅ Đánh dấu batch đã gửi task tự động
        updateBatch.uploadTaskSent = true;
        updateBatch.uploadTaskSentAt = new Date();
        updateBatch.uploadTaskSentBy = "auto";
        await updateBatch.save();

        // Log task với thông tin chi tiết
        await RealtimeLog.create({
          machineId: original.machineId,
          label: original.label,
          action: "auto",
          level: "info",
          message: `Auto sent UPLOAD_TRACKING task for batch update: ${resolvedItems.length} orders, file: ${filename}`,
          ts: new Date(),
        });

        console.log(`✅ [AUTO] Sent UPLOAD_TRACKING task for batch update ${updateBatch._id} to machine:${original.machineId}`);
        console.log(`📄 [AUTO] File: ${filename} (${Buffer.byteLength(fileContent, 'utf8')} bytes)`);
      }
    } catch (taskError) {
      console.error(`❌ [AUTO] Failed to send UPLOAD_TRACKING task for batch update:`, taskError.message);
      // Không throw error, chỉ log để không ảnh hưởng đến flow chính
    }

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
      autoTaskSent: resolvedItems.length > 0, // Thông báo đã gửi task tự động
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

const SHIPPING_CONFIRMATION_HEADERS = [
  "order-id", "order-item-id", "quantity", "ship-date", "carrier-code",
  "carrier-name", "tracking-number", "ship-method", "transparency_code",
  "ship_from_address_name", "ship_from_address_line1", "ship_from_address_line2",
  "ship_from_address_line3", "ship_from_address_city", "ship_from_address_county",
  "ship_from_address_state_or_region", "ship_from_address_postalcode",
  "ship_from_address_countrycode", "ship_from_supply_source_id",
];

function buildCompletedShippingRow(item, options = {}) {
  const {
    carrierCode = "USPS",
    shipMethod = "USPS First Class",
    shipDate,
  } = options;
  if (!item.orderId || !item.tracking) return null;

  const orderId = normalizeField(item.orderId);
  const tracking = normalizeField(item.tracking);
  const itemShipDate = normalizeField(item.shipDate) || normalizeField(shipDate);
  if (!orderId || !tracking) return null;

  let finalCarrierCode = carrierCode;
  let finalShipMethod = shipMethod;

  if (tracking.startsWith("4PX")) {
    finalCarrierCode = "4PX";
    finalShipMethod = "4PX-Global Express";
  }
  if (tracking.startsWith("UK") || tracking.startsWith("UL")) {
    finalCarrierCode = "Yanwen";
    finalShipMethod = "Yanwen Air Economy Mail General";
  }
  if (tracking.startsWith("YT")) {
    finalCarrierCode = "Yun Express";
    finalShipMethod = "YunExpress Global Direct line (standard )-Tracked";
  }
  if (tracking.startsWith("TBA")) {
    finalCarrierCode = "Amazon Shipping";
    finalShipMethod = "Standard Shipping";
  }

  return [
    orderId, "", "", itemShipDate, finalCarrierCode, "", tracking, finalShipMethod,
    "", "", "", "", "", "", "", "", "", "", "",
  ];
}

function buildShippingConfirmationPreview(completed, options = {}) {
  const rows = completed
    .map((item) => buildCompletedShippingRow(item, options))
    .filter(Boolean)
    .map((values) => Object.fromEntries(SHIPPING_CONFIRMATION_HEADERS.map((header, index) => [header, values[index]])));
  return { format: "TSV", headers: SHIPPING_CONFIRMATION_HEADERS, rows };
}

function buildCompletedShippingFile(completed, options = {}) {
  const rows = completed.map((item) => buildCompletedShippingRow(item, options)).filter(Boolean);
  return `${SHIPPING_CONFIRMATION_HEADERS.join("\t")}\n${rows.map((row) => row.join("\t")).join("\n")}${rows.length ? "\n" : ""}`;
}

const idString = (value) => String(value?._id || value || "");

function makeReviewBatchResult(batch, { shopId, shopName, reused = false, excludedOrders = [] } = {}) {
  const completed = batch.completed || [];
  return {
    shopId: idString(batch.shopId) || shopId,
    shopName,
    batchId: batch._id,
    batchLabel: batch.label,
    success: true,
    reused,
    totalOrders: completed.length,
    totalReal: completed.length,
    totalFake: 0,
    autoTaskSent: false,
    excludedOrders,
    uploadPreview: buildShippingConfirmationPreview(completed),
    orders: completed.map((item) => ({
      orderId: item.orderId,
      tracking: item.tracking,
      carrier: item.carrier || "",
      trackingReceivedAt: item.trackingReceivedAt || null,
      shipDate: item.shipDate || "",
      isFake: item.isFake,
      source: item.source,
    })),
  };
}

function draftOwnsCurrentReservations(batch, ordersById) {
  return (batch.completed || []).every((item) => {
    const order = ordersById.get(item.orderId);
    return order?.amazonConfirmation?.state === "reserved"
      && idString(order.amazonConfirmation.batchId) === idString(batch._id);
  });
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

// COMMENTED OUT - removed fake tracking logic
/*
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

    // ✅ 5️⃣ Tự động gửi task UPLOAD_TRACKING cho extension khi có real tracking
    try {
      const io = req.app.get("io");
      if (io && resolvedItems.length > 0) {
        console.log(`🔄 [AUTO] Preparing UPLOAD_TRACKING task for ${resolvedItems.length} real tracking updates...`);
        
        // Tạo file content cho batch mới
        const shipDateStr = buildShipDateString(new Date());
        const fileContent = buildCompletedShippingFile(resolvedItems, {
          carrierCode: "USPS",
          shipMethod: "USPS First Class",
          shipDate: shipDateStr,
        });

        const filename = `update_real_tracking_${updateBatch._id}.txt`;

        const taskPayload = {
          batchId: updateBatch._id,
          machineId,
          label: "Auto Real Tracking Update",
          trackingData: resolvedItems.map(item => ({
            orderId: item.orderId,
            tracking: item.tracking,
            isFake: false,
            source: 'system',
            sourceConfirmBatchId: item.sourceConfirmBatchId
          })),
          stats: updateBatch.stats,

          file: {
            filename,
            content: fileContent,
            contentType: "text/tab-separated-values; charset=utf-8",
            size: Buffer.byteLength(fileContent, 'utf8')
          },

          uploadParams: {
            carrierCode: "USPS",
            shipMethod: "USPS First Class",
            shipDate: shipDateStr
          },

          autoGenerated: true,
          reason: "real_tracking_found",
          timestamp: new Date().toISOString()
        };

        // 🎯 Gửi cho extension của machineId này (persist + taskId tự động)
        await emitTaskToMachine(io, {
          type: "UPLOAD_TRACKING",
          shopId: req.body?.shopId || null,
          machineId,
          payload: taskPayload,
        });

        // ✅ Đánh dấu batch đã gửi task tự động
        updateBatch.uploadTaskSent = true;
        updateBatch.uploadTaskSentAt = new Date();
        updateBatch.uploadTaskSentBy = "auto";
        await updateBatch.save();

        // Log task với thông tin chi tiết
        await RealtimeLog.create({
          machineId,
          label: "Auto Real Tracking Update",
          action: "auto",
          level: "info",
          message: `Auto sent UPLOAD_TRACKING task: ${resolvedItems.length} orders, file: ${filename} (${Buffer.byteLength(fileContent, 'utf8')} bytes)`,
          ts: new Date(),
        });

        console.log(`✅ [AUTO] Sent UPLOAD_TRACKING task for batch ${updateBatch._id} to machine:${machineId}`);
        console.log(`📄 [AUTO] File: ${filename} (${Buffer.byteLength(fileContent, 'utf8')} bytes)`);
        console.log(`📊 [AUTO] Orders: ${resolvedItems.map(i => i.orderId).join(', ')}`);
      }
    } catch (taskError) {
      console.error(`❌ [AUTO] Failed to send UPLOAD_TRACKING task:`, taskError.message);
      // Không throw error, chỉ log để không ảnh hưởng đến flow chính
    }

    return res.status(201).json({
      updateBatchId: updateBatch._id,
      totalUpdatedOrders: resolvedItems.length,
      autoTaskSent: resolvedItems.length > 0, // Thông báo đã gửi task tự động
    });
  } catch (err) {
    next(err);
  }
};
*/

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
      search,
      tracking = "all",
      amazon = "all",
      vendor,
      carrier,
      carrierHandoff = "all",
      shipBy = "all",
      shipByFrom,
      shipByTo,
      page = 1,
      status = ACTIVE_TRACKING_ORDER_STATUSES,
    } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    const result = await checkOrdersStatusRealTime(machineId, {
      limit, page, fromDate, toDate, search, tracking, amazon, vendor, carrier, carrierHandoff, shipBy, shipByFrom, shipByTo, status,
    });

    return res.json(result);

  } catch (err) {
    next(err);
  }
};

/**
 * API gửi task UPLOAD_TRACKING cho extension kèm file content
 * POST /api/shipping-batch/send-upload-task
 * Body: {
 *   batchId: string,
 *   machineId?: string (optional, nếu không có thì broadcast)
 *   shopId?: string (optional, nếu có machineId)
 *   carrierCode?: string (optional, default: "USPS")
 *   shipMethod?: string (optional, default: "USPS First Class")
 *   shipDate?: string (optional, ISO date string)
 * }
 */
const sendUploadTrackingTask = async (req, res, next) => {
  try {
    const {
      batchId,
      machineId,
      shopId,
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
      shipDate
    } = req.body;

    if (!batchId) {
      return res.status(400).json({
        ok: false,
        message: "batchId is required"
      });
    }

    // Lấy thông tin batch
    const batch = await ShippingBatch.findById(batchId);
    if (!batch) {
      return res.status(404).json({
        ok: false,
        message: "Batch not found"
      });
    }

    if (!batch.completed || batch.completed.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "No completed data to upload for this batch"
      });
    }

    // ✅ Tạo file content (giống downloadCompletedFile)
    let shipDateBase;
    if (shipDate) {
      const d = new Date(shipDate);
      if (isNaN(d.getTime())) {
        return res.status(400).json({
          ok: false,
          message: "shipDate is invalid date format"
        });
      }
      shipDateBase = d;
    } else {
      // Dùng ngày tạo batch
      shipDateBase = batch.createdAt ? new Date(batch.createdAt) : new Date();
    }

    const shipDateStr = buildShipDateString(shipDateBase);
    const fileContent = buildCompletedShippingFile(batch.completed, {
      carrierCode,
      shipMethod,
      shipDate: shipDateStr,
    });

    const filename = batch.fileName ||
      (batch.type === "UPDATE_FAKE"
        ? `update_confirmShip_${batch._id}.txt`
        : `confirmShip_${batch._id}.txt`);

    // Chuẩn bị tracking data từ batch
    const trackingData = batch.completed.map(item => ({
      orderId: item.orderId,
      tracking: item.tracking,
      isFake: item.isFake || false,
      source: item.source || 'system'
    }));

    const io = req.app.get("io");
    if (!io) {
      return res.status(500).json({
        ok: false,
        message: "Socket.IO not available"
      });
    }

    const taskPayload = {
      batchId: batch._id,
      machineId: batch.machineId,
      label: batch.label,
      trackingData,
      stats: batch.stats,

      file: {
        filename,
        content: fileContent,
        contentType: "text/tab-separated-values; charset=utf-8",
        size: Buffer.byteLength(fileContent, 'utf8')
      },

      uploadParams: {
        carrierCode,
        shipMethod,
        shipDate: shipDateStr
      },

      timestamp: new Date().toISOString()
    };

    let recipients = 0;
    let targetInfo = "";

    if (machineId) {
      // Gửi cho extension cụ thể
      if (!shopId) {
        return res.status(400).json({
          ok: false,
          message: "shopId is required when machineId is specified"
        });
      }

      await emitTaskToMachine(io, {
        type: "UPLOAD_TRACKING",
        shopId,
        machineId,
        payload: taskPayload,
      });
      recipients = 1;
      targetInfo = `machine:${machineId}`;

    } else {
      // Broadcast cho tất cả extension hoặc gửi cho machine của batch
      if (batch.machineId) {
        await emitTaskToMachine(io, {
          type: "UPLOAD_TRACKING",
          shopId: shopId || null,
          machineId: batch.machineId,
          payload: taskPayload,
        });
        recipients = 1;
        targetInfo = `machine:${batch.machineId}`;
      } else {
        // Broadcast fallback (KHÔNG persist taskId vì không có machineId)
        const broadcastTaskId = buildTaskId({
          type: "UPLOAD_TRACKING",
          shopId: shopId || "broadcast",
          payload: taskPayload,
        });
        io.emit("server:task", {
          taskId: broadcastTaskId,
          type: "UPLOAD_TRACKING",
          payload: { ...taskPayload, taskId: broadcastTaskId },
          sentAt: new Date().toISOString(),
        });
        recipients = io.of("/").sockets.size || 0;
        targetInfo = "all extensions";
      }
    }

    // Log task
    await RealtimeLog.create({
      shopId: shopId || null,
      machineId: machineId || batch.machineId || null,
      label: batch.label,
      action: "api",
      level: "info",
      message: `Sent UPLOAD_TRACKING task for batch ${batch._id} with ${trackingData.length} tracking numbers`,
      ts: new Date(),
    });

    return res.json({
      ok: true,
      batchId: batch._id,
      taskType: "UPLOAD_TRACKING",
      recipients,
      target: targetInfo,
      trackingCount: trackingData.length,
      filename,
      fileSize: Buffer.byteLength(fileContent, 'utf8'),
      uploadParams: {
        carrierCode,
        shipMethod,
        shipDate: shipDateStr
      },
      message: `Upload tracking task with file sent successfully for batch ${batch._id}`
    });

  } catch (err) {
    next(err);
  }
};

/**
 * API cho FE để chủ động gửi task UPLOAD_TRACKING
 * POST /api/shipping-batch/manual-upload-task
 * Body: {
 *   batchId: string,
 *   machineId?: string (optional, nếu không có thì lấy từ batch)
 *   shopId?: string (optional)
 *   carrierCode?: string (optional, default: "USPS")
 *   shipMethod?: string (optional, default: "USPS First Class")
 *   shipDate?: string (optional, ISO date string)
 *   force?: boolean (optional, default: false - bỏ qua check đã gửi)
 * }
 */
const manualUploadTask = async (req, res, next) => {
  try {
    console.log(`🚀 [DEBUG] manualUploadTask called with body:`, JSON.stringify(req.body, null, 2));

    const {
      batchId,
      machineId,
      shopId,
      force = false
    } = req.body;

    console.log(`🚀 [MANUAL] Parameters extracted:`, {
      batchId,
      machineId,
      shopId,
      force
    });

    if (!batchId) {
      console.log('❌ [DEBUG] Missing batchId');
      return res.status(400).json({
        ok: false,
        message: "batchId is required"
      });
    }

    // Lấy thông tin batch
    console.log(`🚀 [MANUAL] Looking up batch: ${batchId}`);
    const batch = await ShippingBatch.findById(batchId);
    if (!batch) {
      console.log(`❌ [MANUAL] Batch not found: ${batchId}`);
      return res.status(404).json({
        ok: false,
        message: "Batch not found"
      });
    }

    console.log(`🚀 [MANUAL] Batch found:`, {
      batchId: batch._id,
      machineId: batch.machineId,
      label: batch.label,
      status: batch.status,
      completedCount: batch.completed?.length || 0,
      uploadTaskSent: batch.uploadTaskSent,
      uploadTaskSentAt: batch.uploadTaskSentAt
    });

    if (!batch.completed || batch.completed.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "No completed data to upload for this batch"
      });
    }

    if (!batch.review?.approvedAt || !batch.review.confirmedSingleShipment || !batch.review.confirmedNoTransparency) {
      return res.status(409).json({ ok: false, message: "Batch must be reviewed before sending to Amazon" });
    }

    // Kiểm tra batch đã được gửi chưa (trừ khi force = true)
    if (!force && batch.uploadTaskSent) {
      return res.status(400).json({
        ok: false,
        message: "Upload task already sent for this batch. Use force=true to resend.",
        lastSentAt: batch.uploadTaskSentAt
      });
    }

    const targetMachineId = machineId || batch.machineId;
    if (!targetMachineId) {
      console.log(`❌ [MANUAL] No machineId available - request: ${machineId}, batch: ${batch.machineId}`);
      return res.status(400).json({
        ok: false,
        message: "machineId is required (either in request body or batch must have machineId)"
      });
    }

    const batchShopId = String(batch.shopId || "");
    if (!batchShopId) {
      return res.status(409).json({ ok: false, message: "Legacy batch has no assigned shop" });
    }
    if (shopId && String(shopId) !== batchShopId) {
      return res.status(409).json({ ok: false, message: "Requested shop does not own this batch" });
    }
    const targetPresence = req.app.get("presence")?.getByMachine(targetMachineId);
    if (!targetPresence || targetPresence.status !== "online" || String(targetPresence.shopId) !== batchShopId) {
      return res.status(409).json({ ok: false, message: "Assigned extension is offline or connected to another shop" });
    }

    const batchOrderIds = batch.completed.map((item) => item.orderId);
    const batchOrders = await OrderCustomProduct.find({
      orderId: { $in: batchOrderIds },
      shopId: batch.shopId,
    }).lean();
    const invalidOrder = batch.completed.find((item) => {
      const order = batchOrders.find((candidate) => candidate.orderId === item.orderId);
      const reservationBelongsToBatch = order?.amazonConfirmation?.state === "reserved"
        && String(order.amazonConfirmation.batchId) === String(batch._id);
      const eligibility = order && evaluateAmazonConfirmationEligibility({
        order: reservationBelongsToBatch ? { ...order, amazonConfirmation: undefined } : order,
      });
      return !eligibility?.readyForReview || eligibility.tracking !== item.tracking || eligibility.carrier !== item.carrier;
    });
    if (invalidOrder) {
      return res.status(409).json({
        ok: false,
        message: "Batch order is no longer eligible for Amazon confirmation",
        orderId: invalidOrder.orderId,
      });
    }

    console.log(`🚀 [MANUAL] Target machineId determined: ${targetMachineId}`);

    const fileContent = buildCompletedShippingFile(batch.completed, {
      carrierCode: "USPS",
      shipMethod: "USPS First Class",
    });

    const filename = batch.fileName ||
      (batch.type === "UPDATE_FAKE" || batch.type === "UPDATE_GLOBAL"
        ? `manual_update_${batch._id}.txt`
        : `manual_upload_${batch._id}.txt`);

    console.log(`🚀 [MANUAL] File info:`, {
      filename,
      contentLength: fileContent.length,
      fileSize: Buffer.byteLength(fileContent, 'utf8')
    });

    // Chuẩn bị tracking data từ batch
    const trackingData = batch.completed.map(item => ({
      orderId: item.orderId,
      tracking: item.tracking,
      isFake: item.isFake || false,
      source: item.source || 'system'
    }));

    console.log(`🚀 [MANUAL] Tracking data prepared:`, {
      trackingCount: trackingData.length,
      sampleTracking: trackingData.slice(0, 3)
    });

    const io = req.app.get("io");
    if (!io) {
      console.log(`❌ [MANUAL] Socket.IO not available in app`);
      return res.status(500).json({
        ok: false,
        message: "Socket.IO not available"
      });
    }

    console.log(`🚀 [MANUAL] Socket.IO instance available:`, {
      ioExists: !!io,
      socketsCount: io.sockets.sockets.size,
      roomsCount: io.sockets.adapter.rooms.size
    });

    const taskPayload = {
      batchId: batch._id,
      machineId: targetMachineId,
      label: batch.label,
      trackingData,
      stats: batch.stats,

      file: {
        filename,
        content: fileContent,
        contentType: "text/tab-separated-values; charset=utf-8",
        size: Buffer.byteLength(fileContent, 'utf8')
      },

      uploadParams: {
        carrierCode: "USPS",
        shipMethod: "USPS First Class",
        shipDate: batch.review.shipDate,
      },

      autoGenerated: false,
      reason: "manual_frontend_request",
      requestedBy: "frontend",
      force: force,
      timestamp: new Date().toISOString()
    };

    let recipients = 0;
    let targetInfo = "";

    console.log(`📡 [MANUAL] Preparing to send Socket.IO task:`, {
      batchId: batch._id,
      targetMachineId,
      shopId,
      trackingCount: trackingData.length,
      ioAvailable: !!io
    });

    const roomName = `machine:${targetMachineId}`;
    const roomSockets = io.sockets.adapter.rooms.get(roomName);
    const roomSize = roomSockets ? roomSockets.size : 0;

    console.log(`📡 [MANUAL] Socket.IO room info:`, {
      roomName,
      roomSize,
      hasClients: roomSize > 0,
      totalSockets: io.sockets.sockets.size
    });
    if (!roomSize) {
      return res.status(409).json({ ok: false, message: "Assigned extension socket is offline" });
    }

    const emitted = await emitTaskToMachine(io, {
      type: "UPLOAD_TRACKING",
      shopId: shopId || null,
      machineId: targetMachineId,
      payload: taskPayload,
    });
    recipients = 1;
    targetInfo = `machine:${targetMachineId}`;
    console.log(`📡 [MANUAL] Task emitted (taskId=${emitted.taskId})`);

    const transitions = await Promise.all(batch.completed.map((item) => markAmazonConfirmationSubmitted({
      OrderModel: OrderCustomProduct,
      orderId: item.orderId,
      shopId: batch.shopId,
      batchId: batch._id,
    })));
    if (transitions.some(({ submitted }) => !submitted)) {
      batch.uploadTaskSent = true;
      batch.uploadTaskSentAt = new Date();
      batch.uploadTaskSentBy = "frontend";
      await batch.save();
      return res.status(409).json({ ok: false, message: "Task was accepted but order reservation state needs review" });
    }

    console.log(`📡 [MANUAL] Task emitted successfully to ${targetInfo} with ${roomSize} clients`);

    // ✅ Đánh dấu batch đã gửi task (để tránh gửi trùng)
    batch.uploadTaskSent = true;
    batch.uploadTaskSentAt = new Date();
    batch.uploadTaskSentBy = "frontend";
    await batch.save();

    // Log task
    await RealtimeLog.create({
      shopId: shopId || null,
      machineId: targetMachineId,
      label: batch.label,
      action: "click",
      level: "info",
      message: `Manual UPLOAD_TRACKING task sent from FE: ${trackingData.length} orders, file: ${filename}`,
      ts: new Date(),
    });

    console.log(`✅ [MANUAL] Sent UPLOAD_TRACKING task for batch ${batch._id} to machine:${targetMachineId} (requested by FE)`);

    return res.json({
      ok: true,
      batchId: batch._id,
      taskType: "UPLOAD_TRACKING",
      recipients,
      target: targetInfo,
      trackingCount: trackingData.length,
      filename,
      fileSize: Buffer.byteLength(fileContent, 'utf8'),
      uploadParams: {
        carrierCode: "USPS",
        shipMethod: "USPS First Class",
        shipDate: batch.review.shipDate
      },
      manual: true,
      force: force,
      message: `Manual upload tracking task sent successfully for batch ${batch._id}`
    });

  } catch (err) {
    next(err);
  }
};

const approveTrackingReview = async (req, res, next) => {
  try {
    const { batchId } = req.params;
    const { shipDate, confirmedSingleShipment, confirmedNoTransparency } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(shipDate || "")) || Number.isNaN(new Date(`${shipDate}T00:00:00Z`).getTime())) {
      return res.status(400).json({ ok: false, message: "shipDate must be YYYY-MM-DD" });
    }
    if (shipDate > amazonUsDate()) {
      return res.status(400).json({ ok: false, message: "shipDate cannot be in the future for Amazon US" });
    }
    if (confirmedSingleShipment !== true || confirmedNoTransparency !== true) {
      return res.status(400).json({ ok: false, message: "Single-shipment and Transparency checks are required" });
    }
    const batch = await ShippingBatch.findById(batchId);
    if (!batch) return res.status(404).json({ ok: false, message: "Batch not found" });
    if (batch.uploadTaskSent) return res.status(409).json({ ok: false, message: "Batch has already been sent" });
    if ((batch.tracking_fakes || []).length || !(batch.completed || []).length) {
      return res.status(400).json({ ok: false, message: "Only complete orders with real tracking can be reviewed" });
    }
    const carrierShipDates = [...new Set((batch.completed || []).map((item) => normalizeField(item.shipDate)).filter(Boolean))];
    if (carrierShipDates.length !== 1) {
      return res.status(409).json({ ok: false, message: "Batch must contain exactly one carrier-confirmed ship date" });
    }
    if (shipDate !== carrierShipDates[0]) {
      return res.status(409).json({ ok: false, message: "shipDate must match the carrier-confirmed date" });
    }
    batch.review = { approvedAt: new Date(), shipDate, confirmedSingleShipment, confirmedNoTransparency };
    await batch.save();
    return res.json({ ok: true, batchId: batch._id, review: batch.review });
  } catch (err) {
    next(err);
  }
};

const discardShippingBatch = async (req, res, next) => {
  try {
    const batch = await ShippingBatch.findById(req.params.batchId);
    if (!batch) return res.status(404).json({ ok: false, message: "Batch not found" });
    if (batch.uploadTaskSent) return res.status(409).json({ ok: false, message: "Submitted batches cannot be discarded" });
    if (!batch.shopId) return res.status(409).json({ ok: false, message: "Legacy batch cannot be discarded safely" });

    const releases = await Promise.all((batch.completed || []).map(({ orderId }) => releaseAmazonConfirmationReservation({
      OrderModel: OrderCustomProduct,
      orderId,
      shopId: batch.shopId,
      batchId: batch._id,
    })));
    await batch.deleteOne();
    return res.json({ ok: true, batchId: batch._id, releasedOrders: releases.filter(Boolean).length });
  } catch (error) {
    next(error);
  }
};

/**
 * API cho FE để lấy danh sách batch có thể upload
 * GET /api/shipping-batch/uploadable
 * Query: {
 *   machineId?: string,
 *   status?: string,
 *   type?: string,
 *   limit?: number
 * }
 */
const getUploadableBatches = async (req, res, next) => {
  try {
    const {
      machineId,
      status = "CONFIRM_FILE_READY",
      type,
      limit = 20,
      page = 1,
    } = req.query;
    const pageSize = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const currentPage = Math.max(Number(page) || 1, 1);

    const filter = {
      status,
      completed: { $exists: true, $ne: [] }
    };

    if (machineId) filter.machineId = machineId;
    if (type) filter.type = type;

    const [batches, total] = await Promise.all([
      ShippingBatch.find(filter)
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * pageSize)
      .limit(pageSize)
      .select({
        _id: 1,
        machineId: 1,
        shopId: 1,
        label: 1,
        type: 1,
        status: 1,
        createdAt: 1,
        fileName: 1,
        stats: 1,
        uploadTaskSent: 1,
        uploadTaskSentAt: 1,
        uploadTaskSentBy: 1,
        completed: 1,
      }),
      ShippingBatch.countDocuments(filter),
    ]);

    const result = batches.map(batch => ({
      ...makeReviewBatchResult(batch, { shopId: batch.shopId }),
      status: batch.status,
      type: batch.type,
      createdAt: batch.createdAt,
      fileName: batch.fileName,
      stats: batch.stats,
      canUpload: !batch.uploadTaskSent, // Có thể upload nếu chưa gửi task
      uploadTaskSent: batch.uploadTaskSent || false,
      uploadTaskSentAt: batch.uploadTaskSentAt || null,
      uploadTaskSentBy: batch.uploadTaskSentBy || null
    }));

    return res.json({
      ok: true,
      total,
      page: currentPage,
      pageSize,
      batches: result
    });

  } catch (err) {
    next(err);
  }
};
/**
 * API tạo batch từ danh sách orders (nhóm theo shopId)
 * POST /api/shipping-batch/create-from-orders
 * Body: {
 *   machineId: string,
 *   orders: [
 *     { orderId: string, shopId: string },
 *     { orderId: string, shopId: string },
 *     ...
 *   ],
 *   label?: string,
 *   carrierCode?: string,
 *   shipMethod?: string,
 *   autoUpload?: boolean (default: true)
 * }
 */
const createBatchFromOrders = async (req, res, next) => {
  try {
    const {
      machineId,
      orders = [],
      label,
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
      autoUpload = false
    } = req.body;

    if (!machineId) {
      return res.status(400).json({
        ok: false,
        message: "machineId is required"
      });
    }

    if (!orders.length) {
      return res.status(400).json({
        ok: false,
        message: "orders array is required and cannot be empty"
      });
    }

    // Validate orders format
    for (const order of orders) {
      if (!order.orderId || !order.shopId) {
        return res.status(400).json({
          ok: false,
          message: "Each order must have orderId and shopId"
        });
      }
    }

    console.log(`🔄 [CREATE_BATCH] Processing ${orders.length} orders for machine:${machineId}`);

    // ✅ Nhóm orders theo shopId
    const ordersByShop = {};
    orders.forEach(order => {
      if (!ordersByShop[order.shopId]) {
        ordersByShop[order.shopId] = [];
      }
      ordersByShop[order.shopId].push(order.orderId);
    });

    const shopIds = Object.keys(ordersByShop);
    console.log(`📊 [CREATE_BATCH] Found ${shopIds.length} shops:`, shopIds.map(shopId => `${shopId}(${ordersByShop[shopId].length} orders)`));

    const createdBatches = [];
    const results = [];

    // ✅ Tạo batch riêng cho từng shopId
    for (const shopId of shopIds) {
      const shopOrderIds = ordersByShop[shopId];

      try {
        console.log(`🔄 [CREATE_BATCH] Processing shop ${shopId} with ${shopOrderIds.length} orders`);

        // Lấy thông tin orders từ DB cho shop này (populate để lấy tên shop)
        const shopOrders = await OrderCustomProduct.find({
          orderId: { $in: shopOrderIds },
          shopId: shopId
        }).populate('shopId', 'name store').lean();

        if (!shopOrders.length) {
          console.log(`⚠️ [CREATE_BATCH] No orders found for shop ${shopId}`);
          results.push({
            shopId,
            success: false,
            message: "No orders found in database",
            orderCount: 0
          });
          continue;
        }

        const requestedOrderIds = new Set(shopOrderIds);
        const ordersById = new Map(shopOrders.map((order) => [order.orderId, order]));
        const draftBatches = await ShippingBatch.find({
          shopId,
          type: "CONFIRM",
          uploadTaskSent: false,
          $or: [
            { "review.approvedAt": { $exists: false } },
            { "review.approvedAt": null },
          ],
        }).lean();
        const reusableDrafts = draftBatches.filter((batch) => {
          const batchOrderIds = (batch.completed || []).map((item) => item.orderId);
          return batchOrderIds.length
            && batchOrderIds.every((orderId) => requestedOrderIds.has(orderId))
            && draftOwnsCurrentReservations(batch, ordersById);
        });
        const reusedOrderIds = new Set(reusableDrafts.flatMap((batch) => (batch.completed || []).map((item) => item.orderId)));
        const reservedButNotReusable = shopOrders.filter((order) => order.amazonConfirmation?.state === "reserved" && !reusedOrderIds.has(order.orderId));
        const invalidDraft = reusableDrafts.find((batch) => new Set((batch.completed || []).map((item) => normalizeField(item.shipDate)).filter(Boolean)).size !== 1);

        if (invalidDraft) {
          results.push({
            shopId,
            success: false,
            message: "Draft batch has multiple carrier ship dates and must be discarded before recreating it.",
            excludedOrders: (invalidDraft.completed || []).map((item) => ({ orderId: item.orderId, reason: "DRAFT_BATCH_MIXED_SHIP_DATES" })),
            orderCount: shopOrderIds.length,
          });
          continue;
        }

        if (reservedButNotReusable.length) {
          results.push({
            shopId,
            success: false,
            message: "A selected order is reserved by another Amazon confirmation draft.",
            excludedOrders: reservedButNotReusable.map((order) => ({ orderId: order.orderId, reason: "AMAZON_CONFIRMATION_EXISTS" })),
            orderCount: shopOrderIds.length,
          });
          continue;
        }

        const completed = [];
        const tracking_fakes = [];
        const excludedOrders = [];
        let totalReal = 0;
        let totalFake = 0;

        // Xử lý từng order — đọc tracking trực tiếp từ data đã fetch (tránh N+1 query)
        for (const draft of reusableDrafts) {
          const shopInfo = shopOrders[0];
          const shopName = shopInfo.shopId?.name || shopInfo.shopId?.store || `Shop ${shopId}`;
          results.push(makeReviewBatchResult(draft, { shopId, shopName, reused: true }));
        }

        for (const order of shopOrders.filter((order) => !reusedOrderIds.has(order.orderId))) {
          const orderId = order.orderId;
          const shipment = getOrderShipmentSnapshot(order);

          if (shipment.bulkConfirmEligible) {
            completed.push({
              orderId,
              tracking: shipment.tracking,
              carrier: shipment.trackingInfo?.carrier || "",
              trackingReceivedAt: shipment.trackingInfo?.trackingReceivedAt || null,
              shipDate: shipment.trackingInfo?.actualShipAt ? amazonUsDate(shipment.trackingInfo.actualShipAt) : "",
              isFake: false,
              source: "system",
              createdAt: new Date()
            });
            totalReal++;
          } else {
            excludedOrders.push({
              orderId,
              reason: shipment.bulkBlockReason,
              trackingCount: shipment.trackingCount,
            });
          }
        }

        if (!completed.length && !reusableDrafts.length) {
          results.push({
            shopId,
            success: false,
            message: "No selected orders are eligible for whole-order confirmation.",
            excludedOrders,
            orderCount: shopOrderIds.length,
          });
          continue;
        }

        if (!completed.length) continue;

        // Lấy shop name từ populated shopId
        const shopInfo = shopOrders[0];
        const shopName = shopInfo.shopId?.name || shopInfo.shopId?.store || `Shop ${shopId}`;
        const batchLabelBase = label ? `${label} - ${shopName}` : `FE Batch - ${shopName}`;
        const completedByShipDate = new Map();
        for (const item of completed) {
          const shipDate = normalizeField(item.shipDate);
          if (!completedByShipDate.has(shipDate)) completedByShipDate.set(shipDate, []);
          completedByShipDate.get(shipDate).push(item);
        }

        for (const [shipDate, batchCompleted] of completedByShipDate) {
        const batchLabel = completedByShipDate.size > 1 ? `${batchLabelBase} · ${shipDate}` : batchLabelBase;
        const batchId = new Types.ObjectId();
        const reservedOrderIds = [];
        let reservationFailed = false;
        for (const item of batchCompleted) {
          const reservation = await reserveAmazonConfirmation({
            OrderModel: OrderCustomProduct,
            orderId: item.orderId,
            shopId,
            batchId,
          });
          if (reservation.reserved) {
            reservedOrderIds.push(item.orderId);
            continue;
          }

          await Promise.all(reservedOrderIds.map((orderId) => releaseAmazonConfirmationReservation({
            OrderModel: OrderCustomProduct,
            orderId,
            shopId,
            batchId,
          })));
          results.push({
            shopId,
            success: false,
            message: "An order is already reserved for Amazon confirmation.",
            excludedOrders: [{ orderId: item.orderId, reason: "AMAZON_CONFIRMATION_EXISTS" }],
            orderCount: shopOrderIds.length,
          });
          reservationFailed = true;
          break;
        }

        if (reservationFailed) continue;

        let batch;
        try {
          batch = await ShippingBatch.create({
            _id: batchId,
            machineId,
            shopId,
            label: batchLabel,
            type: "CONFIRM",
            status: "CONFIRM_FILE_READY",
            completed: batchCompleted,
            tracking_fakes,
            stats: {
              totalOrders: batchCompleted.length,
              totalReal: batchCompleted.length,
              totalFake
            }
          });
        } catch (error) {
          await Promise.all(reservedOrderIds.map((orderId) => releaseAmazonConfirmationReservation({
            OrderModel: OrderCustomProduct,
            orderId,
            shopId,
            batchId,
          })));
          throw error;
        }

        createdBatches.push(batch);

        console.log(`✅ [CREATE_BATCH] Created batch ${batch._id} for shop ${shopId} with ${batchCompleted.length} orders (${batchCompleted.length} real, ${totalFake} fake)`);

        // Shipping confirmation changes the seller account; dispatch only after review.
        let autoTaskSent = false;
        const canAutoDispatch = false;
        if (canAutoDispatch && autoUpload && batchCompleted.length > 0) {
          try {
            const io = req.app.get("io");
            if (io) {
              console.log(`🔌 [DEBUG] Socket.IO available, total clients: ${io.of("/").sockets.size}`);

              // ✅ Kiểm tra room trước khi gửi
              const roomName = `machine:${machineId}`;
              const roomSockets = await io.in(roomName).fetchSockets();
              console.log(`🏠 [DEBUG] Room ${roomName} has ${roomSockets.length} sockets:`);
              roomSockets.forEach((sock, index) => {
                console.log(`  Socket ${index + 1}: ${sock.id} (machine: ${sock.data?.machineId}, shop: ${sock.data?.shopId})`);
              });

              if (roomSockets.length === 0) {
                console.log(`⚠️ [DEBUG] No sockets in room ${roomName} - task will not be received!`);
              }
              // Tạo file content
              const shipDateStr = buildShipDateString(new Date());
              const fileContent = buildCompletedShippingFile(batchCompleted, {
                carrierCode,
                shipMethod,
                shipDate: shipDateStr,
              });

              const filename = `fe_batch_${shopName.replace(/[^a-zA-Z0-9]/g, '_')}_${batch._id}.txt`;

              const taskPayload = {
                batchId: batch._id,
                machineId,
                shopId,
                label: batchLabel,
                trackingData: batchCompleted.map(item => ({
                  orderId: item.orderId,
                  tracking: item.tracking,
                  isFake: item.isFake,
                  source: item.source
                })),
                stats: batch.stats,

                file: {
                  filename,
                  content: fileContent,
                  contentType: "text/tab-separated-values; charset=utf-8",
                  size: Buffer.byteLength(fileContent, 'utf8')
                },

                uploadParams: {
                  carrierCode,
                  shipMethod,
                  shipDate: shipDateStr
                },

                autoGenerated: false,
                reason: "fe_batch_creation",
                requestedBy: "frontend",
                timestamp: new Date().toISOString()
              };

              const emitted = await emitTaskToMachine(io, {
                type: "UPLOAD_TRACKING",
                shopId,
                machineId,
                payload: taskPayload,
              });
              console.log(`✅ [DEBUG] Task emitted (taskId=${emitted.taskId}) to room ${roomName}`);

              // Đánh dấu đã gửi
              batch.uploadTaskSent = true;
              batch.uploadTaskSentAt = new Date();
              batch.uploadTaskSentBy = "frontend";
              await batch.save();

              autoTaskSent = true;

              // Log
              await RealtimeLog.create({
                shopId,
                machineId,
                label: batchLabel,
                action: "create_batch",
                level: "info",
                message: `Created batch from FE orders and sent upload task: ${batchCompleted.length} orders for shop ${shopName}`,
                ts: new Date(),
              });

              console.log(`✅ [CREATE_BATCH] Auto sent upload task for batch ${batch._id} (shop: ${shopName})`);
            }
          } catch (taskError) {
            console.error(`❌ [CREATE_BATCH] Failed to send auto upload task for shop ${shopId}:`, taskError.message);
          }
        }

        results.push({
          ...makeReviewBatchResult(batch, { shopId, shopName, excludedOrders }),
          batchLabel,
          totalFake,
          autoTaskSent,
        });
        }

      } catch (shopError) {
        console.error(`❌ [CREATE_BATCH] Failed to process shop ${shopId}:`, shopError.message);
        results.push({
          shopId,
          success: false,
          message: shopError.message,
          orderCount: shopOrderIds.length
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    const totalOrdersProcessed = results.reduce((sum, r) => sum + (r.totalOrders || 0), 0);

    return res.status(201).json({
      ok: true,
      totalShops: shopIds.length,
      successfulBatches: successCount,
      failedBatches: failedCount,
      totalOrdersProcessed,
      batches: results,
      message: `Created ${successCount} batches for ${shopIds.length} shops with ${totalOrdersProcessed} total orders`
    });

  } catch (err) {
    next(err);
  }
};

// ─── Private helpers for checkOrdersStatus ───────────────────────────────────

const ACTIVE_TRACKING_ORDER_STATUSES = ["New", "Fulfilled", "Shipping", "Shipped"];
const CHECK_ORDERS_MAX_LIMIT = 1000;

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseYmd(value, endExclusive = false) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (endExclusive) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function validTrackingMatcher() {
  return { $regex: "^(?!-+$).*\\S" };
}

function buildCheckOrdersQuery(machineId, { status, fromDate, toDate, search, tracking, vendor, carrier, carrierHandoff, shipBy, shipByFrom, shipByTo } = {}) {
  const requestedStatuses = Array.isArray(status)
    ? status
    : String(status || "").split(",");
  const allowedStatuses = requestedStatuses.filter((item) => ACTIVE_TRACKING_ORDER_STATUSES.includes(item));
  const orderFilter = {
    status: { $in: allowedStatuses.length ? allowedStatuses : ACTIVE_TRACKING_ORDER_STATUSES },
    shopId: machineId,
  };
  const from = parseYmd(fromDate);
  const to = parseYmd(toDate, true);
  if (from || to) {
    orderFilter.createdAt = {};
    if (from) orderFilter.createdAt.$gte = from;
    if (to) orderFilter.createdAt.$lt = to;
  }

  const term = String(search || "").trim().slice(0, 100);
  if (term) {
    const escaped = escapeRegex(term);
    orderFilter.$or = [
      { orderId: { $regex: escaped, $options: "i" } },
      { "items.tracking_info.tracking": { $regex: escaped, $options: "i" } },
    ];
  }

  const itemFilter = {};
  const vendorName = String(vendor || "").trim().slice(0, 80);
  const carrierName = String(carrier || "").trim().slice(0, 80);
  if (vendorName) itemFilter["tracking_info.fulfillment"] = { $regex: `^${escapeRegex(vendorName)}$`, $options: "i" };
  if (carrierName) itemFilter["tracking_info.carrier"] = { $regex: `^${escapeRegex(carrierName)}$`, $options: "i" };
  if (carrierHandoff === "yes") itemFilter["tracking_info.actualShipAt"] = { $type: "date" };
  if (carrierHandoff === "no") itemFilter["tracking_info.actualShipAt"] = null;
  if (tracking === "yes") {
    itemFilter["tracking_info.tracking"] = validTrackingMatcher();
  }

  const shipByStart = parseYmd(shipByFrom);
  const shipByEnd = parseYmd(shipByTo, true);
  if (shipBy === "missing") {
    orderFilter.shipByDate = null;
  } else if (shipBy === "overdue" && shipByStart) {
    orderFilter.shipByDate = { $lt: shipByStart };
  } else if (shipByStart || shipByEnd) {
    orderFilter.shipByDate = {};
    if (shipByStart) orderFilter.shipByDate.$gte = shipByStart;
    if (shipByEnd) orderFilter.shipByDate.$lt = shipByEnd;
  }
  if (Object.keys(itemFilter).length) {
    orderFilter.items = { $elemMatch: itemFilter };
  }
  if (tracking === "no") {
    orderFilter.$nor = [{ items: { $elemMatch: { "tracking_info.tracking": validTrackingMatcher() } } }];
  }
  return orderFilter;
}

const _extractOrderDetails = (orders) =>
  orders.map(order => {
    const shipment = getOrderShipmentSnapshot(order);

    return {
      orderId: order.orderId,
      shopId: order.shopId?._id || order.shopId,
      shopName: order.shopId?.name || null,
      shopStore: order.shopId?.store || null,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      shipByDate: order.shipByDate || null,
      earliestShipDate: order.earliestShipDate || null,
      buyerRequestedCancellation: Boolean(order.buyerRequestedCancellation),
      buyerRequestedCancelReason: order.buyerRequestedCancelReason || "",
      hasTracking: shipment.hasTracking,
      tracking: shipment.tracking || null,
      trackingInfo: shipment.trackingInfo,
      itemsCount: (order.items || []).length,
      shipmentItems: shipment.items,
      trackingCount: shipment.trackingCount,
      isSplitShipment: shipment.isSplitShipment,
      eligibility: shipment.eligibility,
      bulkConfirmEligible: shipment.bulkConfirmEligible,
      bulkBlockReason: shipment.bulkBlockReason,
      customerEmail: order.customer?.email || null,
      totalAmount: order.total_amount || 0,
    };
  });

function getOrderShipmentSnapshot(order = {}) {
  const eligibility = evaluateAmazonConfirmationEligibility({ order });
  const items = [];
  for (const item of order.items || []) {
    const tracking = normalizeField(item?.tracking_info?.tracking);
    if (!tracking || tracking === "-" || tracking === "---") continue;
    items.push({
      orderItemId: item?.orderItemId || "",
      quantity: Number(item?.quantity) || 1,
      tracking,
      carrier: carrierFromTrackingInfo(item?.tracking_info),
      fulfillment: item?.tracking_info?.fulfillment || "",
      trackingReceivedAt: item?.tracking_info?.trackingReceivedAt || null,
      actualShipAt: item?.tracking_info?.actualShipAt || null,
      shipEvidence: item?.tracking_info?.shipEvidence || null,
      updatedAt: item?.tracking_info?.updated_at || null,
    });
  }
  const trackingNumbers = [...new Set(items.map((item) => item.tracking))];
  const trackingItem = items[0] || null;
  const isSplitShipment = trackingNumbers.length > 1;
  const firstReason = eligibility.reasons[0] || "";
  const bulkBlockReason = firstReason === "SPLIT_OR_UNTRACKED_ITEM" ? "SPLIT_SHIPMENT" : firstReason;
  return {
    hasTracking: !!trackingItem,
    tracking: trackingItem?.tracking || "",
    trackingInfo: trackingItem ? {
      tracking: trackingItem.tracking,
      fulfillment: trackingItem.fulfillment,
      status: "",
      carrier: trackingItem.carrier,
      trackingReceivedAt: trackingItem.trackingReceivedAt,
      actualShipAt: trackingItem.actualShipAt,
      shipEvidence: trackingItem.shipEvidence,
      updated_at: trackingItem.updatedAt,
    } : null,
    items,
    trackingCount: trackingNumbers.length,
    isSplitShipment,
    eligibility,
    bulkConfirmEligible: eligibility.readyForReview,
    bulkBlockReason,
  };
}

const _buildSubmissionMap = async (orderIds, machineId) => {
  const orderIdsSet = new Set(orderIds);
  const successfulTasks = await ExtensionTask.find({
    machineId,
    type: "UPLOAD_TRACKING",
    status: "completed",
    "result.upload.ok": true,
  })
    .select("payload.batchId completedAt")
    .sort({ completedAt: 1 })
    .lean();
  const submittedAtByBatchId = new Map(successfulTasks
    .filter((task) => task.payload?.batchId)
    .map((task) => [String(task.payload.batchId), task.completedAt]));
  if (!submittedAtByBatchId.size) return new Map();

  const submittedBatches = await ShippingBatch.find({
    machineId,
    _id: { $in: [...submittedAtByBatchId.keys()] },
    "completed.orderId": { $in: orderIds },
  })
    .select('_id type label createdAt completed.orderId')
    .sort({ createdAt: 1 })
    .lean();

  const map = new Map();
  for (const batch of submittedBatches) {
    for (const completed of batch.completed || []) {
      if (!orderIdsSet.has(completed.orderId)) continue;
      map.set(completed.orderId, {
        submittedToAmazon: true,
        batchId: batch._id,
        batchType: batch.type,
        submittedAt: submittedAtByBatchId.get(String(batch._id)),
        batchLabel: batch.label,
      });
    }
  }
  return map;
};

const _calcStats = (orders, filteredCount) => {
  let totalWithTracking = 0, totalSubmitted = 0, totalNotSubmitted = 0;
  for (const o of orders) {
    if (o.hasTracking) totalWithTracking++;
    if (o.submittedToAmazon) totalSubmitted++;
    if (o.hasTracking && !o.submittedToAmazon) totalNotSubmitted++;
  }
  return {
    totalScanned: orders.length,
    totalWithTracking,
    totalWithoutTracking: orders.length - totalWithTracking,
    totalSubmitted,
    totalNotSubmitted,
    filteredCount,
  };
};

// ─────────────────────────────────────────────────────────────────────────────

async function checkOrdersStatusRealTime(machineId, options) {
  const { limit, page, fromDate, toDate, search, tracking, amazon, vendor, carrier, carrierHandoff, shipBy, shipByFrom, shipByTo, status } = options;

  console.log(`⚡ [REAL_TIME] Using real-time query for shop: ${machineId}`);

  const safeLimit = Math.min(Math.max(Math.floor(Number(limit)) || 20, 1), CHECK_ORDERS_MAX_LIMIT);
  const safePage = Math.max(Math.floor(Number(page)) || 1, 1);
  const baseOrderFilter = buildCheckOrdersQuery(machineId, { status, fromDate, toDate, search, tracking: "all" });
  const orderFilter = buildCheckOrdersQuery(machineId, { status, fromDate, toDate, search, tracking, vendor, carrier, carrierHandoff, shipBy, shipByFrom, shipByTo });

  if (amazon === "yes" || amazon === "no") {
    const successfulTasks = await ExtensionTask.find({
      machineId,
      type: "UPLOAD_TRACKING",
      status: "completed",
      "result.upload.ok": true,
    }).select("payload.batchId").lean();
    const submittedBatches = await ShippingBatch.find({
      machineId,
      _id: { $in: successfulTasks.map((task) => task.payload?.batchId).filter(Boolean) },
      "completed.0": { $exists: true },
    }).select("completed.orderId").lean();
    const submittedOrderIds = [...new Set(submittedBatches.flatMap((batch) =>
      (batch.completed || []).map((item) => item.orderId).filter(Boolean)
    ))];
    if (amazon === "yes") {
      if (!submittedOrderIds.length) return { orders: [], totalCount: 0, stats: _calcStats([], 0), dataSource: "real-time" };
      orderFilter.orderId = { $in: submittedOrderIds };
    } else if (submittedOrderIds.length) {
      orderFilter.orderId = { $nin: submittedOrderIds };
    }
  }

  // Fetch shop once (all orders for machineId belong to this shop) — tránh .populate() N+1
  const shop = await Shop.findById(machineId).select('name store').lean();

  const [allOrders, totalCount, totalScanned, totalWithTracking, vendors, carriers] = await Promise.all([
    OrderCustomProduct.find(orderFilter)
    .select('orderId shopId status createdAt updatedAt shipByDate earliestShipDate buyerRequestedCancellation buyerRequestedCancelReason amazonConfirmation items.orderItemId items.quantity items.tracking_info.tracking items.tracking_info.carrier items.tracking_info.trackingReceivedAt items.tracking_info.actualShipAt items.tracking_info.shipEvidence items.tracking_info.fulfillment items.tracking_info.status items.tracking_info.note items.tracking_info.updated_at customer.email total_amount')
    .sort({ createdAt: -1 })
    .skip((safePage - 1) * safeLimit)
    .limit(safeLimit)
    .lean(),
    OrderCustomProduct.countDocuments(orderFilter),
    OrderCustomProduct.countDocuments(baseOrderFilter),
    OrderCustomProduct.countDocuments({ ...baseOrderFilter, items: { $elemMatch: { "tracking_info.tracking": validTrackingMatcher() } } }),
    OrderCustomProduct.distinct("items.tracking_info.fulfillment", baseOrderFilter),
    OrderCustomProduct.distinct("items.tracking_info.carrier", baseOrderFilter),
  ]);

  const filterOptions = {
    vendors: vendors.filter(Boolean).sort((a, b) => a.localeCompare(b)),
    carriers: carriers.filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };

  if (!allOrders.length) {
    return {
      orders: [],
      totalCount,
      page: safePage,
      pageSize: safeLimit,
      filterOptions,
      dataSource: 'real-time',
      filter: { machineId, limit: safeLimit, page: safePage, fromDate, toDate, search, tracking, amazon, vendor, carrier, carrierHandoff, shipBy, shipByFrom, shipByTo, status },
    };
  }

  // Inject shop info để _extractOrderDetails đọc được name/store
  if (shop) {
    const shopInfo = { _id: shop._id, name: shop.name, store: shop.store };
    for (const order of allOrders) order.shopId = shopInfo;
  }

  const ordersWithDetails = _extractOrderDetails(allOrders);

  const submissionMap = await _buildSubmissionMap(
    ordersWithDetails.map(o => o.orderId),
    machineId
  );

  const finalOrders = ordersWithDetails.map(order => {
    const subInfo = submissionMap.get(order.orderId);
    return {
      ...order,
      submittedToAmazon: !!subInfo,
      createAtToAmz: subInfo?.submittedAt || null,
      submissionInfo: subInfo || null,
    };
  });

  return {
    orders: finalOrders,
    totalCount,
    page: safePage,
    pageSize: safeLimit,
    filterOptions,
    stats: {
      ..._calcStats(finalOrders, totalCount),
      totalScanned,
      totalWithTracking,
      totalWithoutTracking: Math.max(totalScanned - totalWithTracking, 0),
    },
    dataSource: 'real-time',
    filter: { machineId, limit: safeLimit, page: safePage, fromDate, toDate, search, tracking, amazon, vendor, carrier, carrierHandoff, shipBy, shipByFrom, shipByTo, status },
  };
}

module.exports = {
  createBatchFromFile,
  listShippingBatches,
  createUpdateBatchFromSystem,
  downloadCompletedFile,
  downloadAllUpdatedFakeFile,
  exportOrdersWithTracking,
  checkOrdersStatus,
  manualUploadTask,
  approveTrackingReview,
  discardShippingBatch,
  getUploadableBatches,
  createBatchFromOrders,
  downloadAmazonFeedReport,
  _test: { buildCheckOrdersQuery, extractOrderDetails: _extractOrderDetails, getOrderShipmentSnapshot },
};
