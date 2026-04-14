const db = require("../models");
const ShippingBatch = db.ShippingBatch;
const OrderCustomProduct = db.orderCustomProduct;
const RealtimeLog = db.RealtimeLog;
const AutoJobLog = db.AutoJobLog;
const OrderStatusSnapshot = db.OrderStatusSnapshot;
const OrderStatusSyncService = require("../service/orderStatusSync");
const SnapshotAutoSyncService = require("../service/snapshotAutoSync");
const AutoUploadTrackingService = require("../service/autoUploadTrackingService");

async function getRealTrackingForOrder(orderId) {
  const order = await OrderCustomProduct.findOne({ orderId: orderId });
  return order?.items[0]?.tracking_info?.tracking || null;
}

/**
 * 🚀 OPTIMIZED: Extract tracking directly from order data (no DB query)
 */
function extractTrackingFromOrder(order) {
  for (const item of order.items || []) {
    const itemTracking = normalizeField(item?.tracking_info?.tracking);
    if (itemTracking && itemTracking !== "-" && itemTracking !== "---") {
      return itemTracking;
    }
  }
  return null;
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

    // 🔄 AUTO SYNC: Tự động cập nhật snapshots
    try {
      console.log(`🔄 [AUTO_SYNC] Triggering auto sync for batch: ${batch._id}`);
      await SnapshotAutoSyncService.updateBatchSubmissionStatus(batch._id, machineId);
    } catch (syncError) {
      console.error(`⚠️ [AUTO_SYNC] Failed to auto sync snapshots:`, syncError.message);
      // Không throw error để không ảnh hưởng đến flow chính
    }

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

        const task = {
          type: "UPLOAD_TRACKING",
          payload: {
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

            autoGenerated: true, // Đánh dấu là tự động tạo từ real tracking
            reason: "batch_update_real_tracking", // Lý do tạo task
            originalBatchId: original._id,
            timestamp: new Date().toISOString()
          }
        };

        // 🎯 Gửi cho extension của machineId này
        io.to(`machine:${original.machineId}`).emit("server:task", task);

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

        const task = {
          type: "UPLOAD_TRACKING",
          payload: {
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
            
            autoGenerated: true, // Đánh dấu là tự động tạo từ real tracking
            reason: "real_tracking_found", // Lý do tạo task
            timestamp: new Date().toISOString()
          }
        };

        // 🎯 Gửi cho extension của machineId này
        io.to(`machine:${machineId}`).emit("server:task", task);

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
      status = ["New", "Processing", "Shipped"],
      filterType = "all", // "all", "with-tracking", "without-tracking", "submitted", "not-submitted"
      useSnapshot = "auto", // "auto", "hybrid", "snapshot-only", "real-time", "snapshot-priority"
    } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    console.log(`🔍 [CHECK_ORDERS] Mode: ${useSnapshot} for shop: ${machineId}`);

    // Route to different processing modes
    let result;
    switch (useSnapshot) {
      case "snapshot-only":
        result = await checkOrdersStatusFromSnapshot(machineId, { limit, fromDate, toDate, status, filterType });
        break;
      case "hybrid":
        result = await checkOrdersStatusHybrid(machineId, { limit, fromDate, toDate, status, filterType });
        break;
      case "snapshot-priority":
        result = await checkOrdersStatusSnapshotPriority(machineId, { limit, fromDate, toDate, status, filterType });
        break;
      case "real-time":
      default:
        result = await checkOrdersStatusRealTime(machineId, { limit, fromDate, toDate, status, filterType });
        break;
    }

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

    const task = {
      type: "UPLOAD_TRACKING",
      payload: {
        batchId: batch._id,
        machineId: batch.machineId,
        label: batch.label,
        trackingData,
        stats: batch.stats,

        // ✅ File information
        file: {
          filename,
          content: fileContent,
          contentType: "text/tab-separated-values; charset=utf-8",
          size: Buffer.byteLength(fileContent, 'utf8')
        },

        // ✅ Upload parameters
        uploadParams: {
          carrierCode,
          shipMethod,
          shipDate: shipDateStr
        },

        timestamp: new Date().toISOString()
      }
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

      io.to(`machine:${machineId}`).emit("server:task", task);
      recipients = 1;
      targetInfo = `machine:${machineId}`;

    } else {
      // Broadcast cho tất cả extension hoặc gửi cho machine của batch
      if (batch.machineId) {
        io.to(`machine:${batch.machineId}`).emit("server:task", task);
        recipients = 1;
        targetInfo = `machine:${batch.machineId}`;
      } else {
        io.emit("server:task", task);
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
    console.log('🚀 [DEBUG] manualUploadTask called with body:', JSON.stringify(req.body, null, 2));

    const {
      batchId,
      machineId,
      shopId,
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
      shipDate,
      force = false
    } = req.body;

    if (!batchId) {
      console.log('❌ [DEBUG] Missing batchId');
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
      return res.status(400).json({
        ok: false,
        message: "machineId is required (either in request body or batch must have machineId)"
      });
    }

    // ✅ Tạo file content
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
      // Dùng ngày tạo batch hoặc ngày hiện tại
      shipDateBase = batch.createdAt ? new Date(batch.createdAt) : new Date();
    }

    const shipDateStr = buildShipDateString(shipDateBase);
    const fileContent = buildCompletedShippingFile(batch.completed, {
      carrierCode,
      shipMethod,
      shipDate: shipDateStr,
    });

    const filename = batch.fileName ||
      (batch.type === "UPDATE_FAKE" || batch.type === "UPDATE_GLOBAL"
        ? `manual_update_${batch._id}.txt`
        : `manual_upload_${batch._id}.txt`);

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

    const task = {
      type: "UPLOAD_TRACKING",
      payload: {
        batchId: batch._id,
        machineId: targetMachineId,
        label: batch.label,
        trackingData,
        stats: batch.stats,

        // ✅ File information
        file: {
          filename,
          content: fileContent,
          contentType: "text/tab-separated-values; charset=utf-8",
          size: Buffer.byteLength(fileContent, 'utf8')
        },

        // ✅ Upload parameters
        uploadParams: {
          carrierCode,
          shipMethod,
          shipDate: shipDateStr
        },

        autoGenerated: false, // Đánh dấu là manual từ FE
        reason: "manual_frontend_request", // Lý do tạo task
        requestedBy: "frontend",
        force: force,
        timestamp: new Date().toISOString()
      }
    };

    let recipients = 0;
    let targetInfo = "";

    if (shopId) {
      // Gửi cho extension cụ thể với shopId
      io.to(`machine:${targetMachineId}`).emit("server:task", task);
      recipients = 1;
      targetInfo = `machine:${targetMachineId}`;
    } else {
      // Gửi cho machine của batch
      io.to(`machine:${targetMachineId}`).emit("server:task", task);
      recipients = 1;
      targetInfo = `machine:${targetMachineId}`;
    }

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
      action: "manual",
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
        carrierCode,
        shipMethod,
        shipDate: shipDateStr
      },
      manual: true,
      force: force,
      message: `Manual upload tracking task sent successfully for batch ${batch._id}`
    });

  } catch (err) {
    next(err);
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
      limit = 20
    } = req.query;

    const filter = {
      status,
      completed: { $exists: true, $ne: [] }
    };

    if (machineId) filter.machineId = machineId;
    if (type) filter.type = type;

    const batches = await ShippingBatch.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .select({
        _id: 1,
        machineId: 1,
        label: 1,
        type: 1,
        status: 1,
        createdAt: 1,
        fileName: 1,
        stats: 1,
        uploadTaskSent: 1,
        uploadTaskSentAt: 1,
        uploadTaskSentBy: 1
      });

    const result = batches.map(batch => ({
      batchId: batch._id,
      machineId: batch.machineId,
      label: batch.label,
      type: batch.type,
      status: batch.status,
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
      total: result.length,
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
      autoUpload = true
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

    // 🚀 PERFORMANCE OPTIMIZATION: Process all shops in parallel
    const shopPromises = shopIds.map(async (shopId) => {
      const shopOrderIds = ordersByShop[shopId];

      try {
        // 🚀 OPTIMIZATION: Single query to get all orders with tracking info
        const shopOrders = await OrderCustomProduct.find({
          orderId: { $in: shopOrderIds },
          shopId: shopId
        }).lean();

        if (!shopOrders.length) {
          return {
            shopId,
            success: false,
            message: "No orders found in database",
            orderCount: 0
          };
        }

        const completed = [];
        const tracking_fakes = [];
        let totalReal = 0;
        let totalFake = 0;

        // 🚀 OPTIMIZATION: Process tracking directly from fetched orders (no additional queries)
        for (const order of shopOrders) {
          const orderId = order.orderId;

          // Extract tracking directly from order data (no additional DB call)
          const realTracking = extractTrackingFromOrder(order);

          if (realTracking && realTracking.trim()) {
            // ✅ Có real tracking
            completed.push({
              orderId,
              tracking: realTracking,
              isFake: false,
              source: "system",
              createdAt: new Date()
            });
            totalReal++;
          } else {
            // Thêm vào tracking_fakes để theo dõi (không có tracking)
            tracking_fakes.push({
              orderId,
              note: "No real tracking available",
              createdAt: new Date()
            });
            totalFake++;
          }
        }

        // Lấy shop name để làm label
        const shopInfo = shopOrders[0]; // Lấy thông tin shop từ order đầu tiên
        const shopName = shopInfo.shopName || shopInfo.shopStore || `Shop ${shopId}`;
        const batchLabel = label ? `${label} - ${shopName}` : `FE Batch - ${shopName}`;

        // 🚀 OPTIMIZATION: Batch all database operations
        const batchOperations = [];

        // Tạo batch cho shop này
        const batch = await ShippingBatch.create({
          machineId,
          label: batchLabel,
          type: "CONFIRM",
          status: "CONFIRM_FILE_READY",
          completed,
          tracking_fakes,
          stats: {
            totalOrders: completed.length,
            totalReal,
            totalFake
          }
        });

        // 🔄 AUTO SYNC: Tự động cập nhật snapshots (non-blocking)
        const syncPromise = SnapshotAutoSyncService.updateBatchSubmissionStatus(batch._id, machineId)
          .catch(syncError => {
            console.error(`⚠️ [AUTO_SYNC] Failed for batch ${batch._id}:`, syncError.message);
          });

        // ✅ Tự động gửi upload task nếu có real tracking và autoUpload = true
        let autoTaskSent = false;
        let taskPromise = Promise.resolve();

        if (autoUpload && totalReal > 0) {
          const io = req.app.get("io");
          if (io) {
            // Tạo file content
            const shipDateStr = buildShipDateString(new Date());
            const fileContent = buildCompletedShippingFile(completed, {
              carrierCode,
              shipMethod,
              shipDate: shipDateStr,
            });

            const filename = `fe_batch_${shopName.replace(/[^a-zA-Z0-9]/g, '_')}_${batch._id}.txt`;

            const task = {
              type: "UPLOAD_TRACKING",
              payload: {
                batchId: batch._id,
                machineId,
                shopId,
                label: batchLabel,
                trackingData: completed.map(item => ({
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
              }
            };

            // Send task and update batch in parallel
            taskPromise = Promise.all([
              // Send socket task
              new Promise((resolve) => {
                io.to(`machine:${machineId}`).emit("server:task", task);
                resolve();
              }),
              // Update batch
              ShippingBatch.findByIdAndUpdate(batch._id, {
                uploadTaskSent: true,
                uploadTaskSentAt: new Date(),
                uploadTaskSentBy: "frontend"
              }),
              // Create log
              RealtimeLog.create({
                shopId,
                machineId,
                label: batchLabel,
                action: "create_batch",
                level: "info",
                message: `Created batch from FE orders and sent upload task: ${completed.length} orders for shop ${shopName}`,
                ts: new Date(),
              })
            ]).then(() => {
              autoTaskSent = true;
            }).catch(taskError => {
              console.error(`⚠️ [TASK_ERROR] Failed to send upload task for batch ${batch._id}:`, taskError.message);
            });
          }
        }

        // Wait for all async operations to complete
        await Promise.all([syncPromise, taskPromise]);

        return {
          shopId,
          shopName,
          batchId: batch._id,
          batchLabel,
          success: true,
          totalOrders: completed.length,
          totalReal,
          totalFake,
          autoTaskSent,
          orders: completed.map(item => ({
            orderId: item.orderId,
            tracking: item.tracking,
            isFake: item.isFake,
            source: item.source
          }))
        };

      } catch (shopError) {
        console.error(`❌ [CREATE_BATCH] Error processing shop ${shopId}:`, shopError.message);
        return {
          shopId,
          success: false,
          message: shopError.message,
          orderCount: shopOrderIds.length
        };
      }
    });

    // 🚀 OPTIMIZATION: Wait for all shops to be processed in parallel
    const shopResults = await Promise.all(shopPromises);
    const successfulBatches = shopResults.filter(r => r.success);

    const successCount = shopResults.filter(r => r.success).length;
    const totalOrdersProcessed = shopResults.reduce((sum, r) => sum + (r.totalOrders || 0), 0);

    console.log(`✅ [CREATE_BATCH] Completed: ${successCount}/${shopIds.length} shops, ${totalOrdersProcessed} orders`);

    return res.status(201).json({
      ok: true,
      totalShops: shopIds.length,
      successfulBatches: successCount,
      failedBatches: shopIds.length - successCount,
      totalOrdersProcessed,
      batches: shopResults,
      message: `Created ${successCount} batches for ${shopIds.length} shops with ${totalOrdersProcessed} total orders`
    });

  } catch (err) {
    console.error(`❌ [CREATE_BATCH] Fatal error:`, err.message);
    next(err);
  }
};

/**
 * Auto Upload Tracking - Tự động upload tracking từ orderStatusSnapshots
 * POST /api/shipping-batch/auto-upload-tracking
 * Body: {
 *   maxOrdersPerShop?: number (default: 50),
 *   onlyWithTracking?: boolean (default: true),
 *   onlyNotSubmitted?: boolean (default: true),
 *   excludeShops?: string[],
 *   includeShops?: string[],
 *   carrierCode?: string (default: "USPS"),
 *   shipMethod?: string (default: "USPS First Class"),
 *   dryRun?: boolean (default: false)
 * }
 */
const autoUploadTracking = async (req, res, next) => {
  try {
    console.log('🚀 [AUTO_UPLOAD_API] Auto upload tracking called with body:', JSON.stringify(req.body, null, 2));

    const {
      maxOrdersPerShop = 50,
      onlyWithTracking = true,
      onlyNotSubmitted = true,
      excludeShops = [],
      includeShops = [],
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
      dryRun = false,
      shopId // Nếu có shopId thì chỉ upload cho shop đó
    } = req.body;

    // Kiểm tra Socket.IO
    const io = req.app.get("io");
    if (!io) {
      return res.status(500).json({
        ok: false,
        message: "Socket.IO not available"
      });
    }

    let result;

    if (shopId) {
      // Upload cho shop cụ thể
      console.log(`🎯 [AUTO_UPLOAD_API] Uploading for specific shop: ${shopId}`);
      
      result = await AutoUploadTrackingService.autoUploadTrackingForShop(shopId, io, {
        maxOrdersPerShop,
        onlyWithTracking,
        onlyNotSubmitted,
        carrierCode,
        shipMethod,
        dryRun
      });
      
    } else {
      // Upload cho tất cả shops
      console.log(`🌐 [AUTO_UPLOAD_API] Uploading for all eligible shops`);
      
      result = await AutoUploadTrackingService.autoUploadTrackingForAllShops(io, {
        maxOrdersPerShop,
        onlyWithTracking,
        onlyNotSubmitted,
        excludeShops,
        includeShops,
        carrierCode,
        shipMethod,
        dryRun
      });
    }

    console.log(`✅ [AUTO_UPLOAD_API] Auto upload completed:`, {
      success: result.success,
      totalShops: result.totalShops || (shopId ? 1 : 0),
      totalOrders: result.totalOrders || 0,
      dryRun
    });

    return res.json({
      ok: result.success,
      ...result,
      dryRun,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ [AUTO_UPLOAD_API] Auto upload failed:', err.message);
    next(err);
  }
};

/**
 * Get Auto Upload Status - Kiểm tra trạng thái auto upload
 * GET /api/shipping-batch/auto-upload-status
 * Query: {
 *   shopId?: string,
 *   limit?: number
 * }
 */
const getAutoUploadStatus = async (req, res, next) => {
  try {
    const { shopId, limit = 10 } = req.query;

    // Query recent auto upload batches
    const filter = {
      "autoUploadInfo.createdByAutoUpload": true
    };

    if (shopId) {
      filter.machineId = shopId;
    }

    const recentBatches = await ShippingBatch.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .select({
        _id: 1,
        machineId: 1,
        label: 1,
        createdAt: 1,
        stats: 1,
        uploadTaskSent: 1,
        uploadTaskSentAt: 1,
        uploadTaskSentBy: 1,
        autoUploadInfo: 1
      });

    // Get eligible orders count từ snapshots
    const shopOrdersMap = await AutoUploadTrackingService.getOrdersGroupedByShop({
      maxOrdersPerShop: 1000, // High limit để count
      onlyWithTracking: true,
      onlyNotSubmitted: true,
      ...(shopId ? { includeShops: [shopId] } : {})
    });

    const eligibleOrdersCount = Array.from(shopOrdersMap.values())
      .reduce((sum, shop) => sum + shop.totalOrders, 0);

    return res.json({
      ok: true,
      recentBatches: recentBatches.map(batch => ({
        batchId: batch._id,
        machineId: batch.machineId,
        label: batch.label,
        createdAt: batch.createdAt,
        ordersCount: batch.stats?.totalOrders || 0,
        uploadTaskSent: batch.uploadTaskSent || false,
        uploadTaskSentAt: batch.uploadTaskSentAt,
        uploadTaskSentBy: batch.uploadTaskSentBy,
        autoUploadInfo: batch.autoUploadInfo
      })),
      eligibleOrdersCount,
      eligibleShopsCount: shopOrdersMap.size,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    next(err);
  }
};

// ✅ Debug version với logs chi tiết về Socket.IO
const debugAutoUploadTracking = async (req, res, next) => {
  console.log('🚀 [DEBUG-AUTO-UPLOAD] Function started');
  const startTime = new Date();
  const isAutoCall = !req.headers['user-agent']; // Auto calls không có user-agent
  console.log('🔍 [DEBUG-AUTO-UPLOAD] About to create AutoJobLog...');

  // Tạo AutoJobLog entry với jobType debug
  let jobLog = null;
  try {
    console.log('🔍 [DEBUG-AUTO-UPLOAD] Creating AutoJobLog entry...');
    jobLog = await AutoJobLog.createExecution(
      'debugAutoUploadTracking',
      'debugAutoUploadTracking',
      {
        isAutoCall,
        requestHeaders: Object.keys(req.headers),
        requestBody: req.body
      }
    );
    console.log('✅ [DEBUG-AUTO-UPLOAD] AutoJobLog created:', jobLog._id);
    await jobLog.addLog('info', `Starting DEBUG auto upload tracking`, {
      startTime: startTime.toISOString(),
      isAutoCall,
      userAgent: req.headers['user-agent'] || 'none'
    });
    console.log('✅ [DEBUG-AUTO-UPLOAD] Initial log added');
  } catch (logError) {
    console.error('❌ [DEBUG-AUTO-UPLOAD] Failed to create debug job log:', logError.message);
    console.error('❌ [DEBUG-AUTO-UPLOAD] Error stack:', logError.stack);
  }

  try {
    const {
      maxBatches = 5,
      dryRun = false,
      carrierCode = "USPS",
      shipMethod = "USPS First Class"
    } = req.body || {};

    console.log(`🔍 [DEBUG-AUTO-UPLOAD][${startTime.toISOString()}] Starting debug auto upload tracking`);

    if (jobLog) {
      await jobLog.addLog('info', 'Debug configuration loaded', {
        maxBatches,
        dryRun,
        carrierCode,
        shipMethod
      });
    }

    // 1. Kiểm tra Socket.IO instance chi tiết
    const io = req.app.get("io");
    console.log(`🔍 [DEBUG-AUTO-UPLOAD] Socket.IO Debug Info:`);
    console.log(`   - IO available: ${!!io}`);
    console.log(`   - IO type: ${typeof io}`);
    
    if (io) {
      console.log(`   - Engine clients: ${io.engine?.clientsCount || 'N/A'}`);
      console.log(`   - Sockets count: ${io.sockets?.sockets?.size || 0}`);
      
      // Liệt kê tất cả rooms
      if (io.sockets?.adapter?.rooms) {
        const allRooms = Array.from(io.sockets.adapter.rooms.keys());
        console.log(`   - Total rooms: ${allRooms.length}`);
        console.log(`   - All rooms:`, allRooms);
        
        // Kiểm tra từng room có client
        const roomsWithClients = [];
        allRooms.forEach(roomName => {
          const clients = io.sockets.adapter.rooms.get(roomName);
          if (clients && clients.size > 0) {
            roomsWithClients.push({
              room: roomName,
              clients: clients.size,
              socketIds: Array.from(clients)
            });
          }
        });
        console.log(`   - Rooms with clients:`, roomsWithClients);

        if (jobLog) {
          await jobLog.addLog('info', 'Socket.IO detailed analysis', {
            ioAvailable: !!io,
            engineClients: io.engine?.clientsCount || 0,
            socketsCount: io.sockets?.sockets?.size || 0,
            totalRooms: allRooms.length,
            allRooms: allRooms.slice(0, 20), // Limit to first 20
            roomsWithClients
          });
        }
      }
    }

    // 2. Tìm uploadable batches
    const query = {
      status: 'CONFIRM_FILE_READY',
      completed: { $exists: true, $ne: [] },
      uploadTaskSent: { $ne: true },
      machineId: { $exists: true, $ne: null }
    };

    const uploadableBatches = await ShippingBatch.find(query)
      .sort({ createdAt: 1 })
      .limit(maxBatches)
      .lean();

    console.log(`📊 [DEBUG-AUTO-UPLOAD] Found ${uploadableBatches.length} uploadable batches`);

    if (jobLog) {
      await jobLog.addLog('info', `Found ${uploadableBatches.length} uploadable batches`, {
        query,
        batchCount: uploadableBatches.length,
        maxBatches
      });
    }

    if (uploadableBatches.length === 0) {
      console.log(`✅ [DEBUG-AUTO-UPLOAD] No batches to debug`);
      
      if (jobLog) {
        await jobLog.setSuccess({
          message: "No batches found for debug upload",
          processed: 0,
          results: []
        }, {
          processed: 0,
          success: 0,
          failed: 0
        });
      }

      return res.json({
        ok: true,
        message: "No batches found for debug upload",
        processed: 0,
        results: []
      });
    }

    // 3. Group batches theo machineId và debug từng shop
    const batchesByMachine = {};
    uploadableBatches.forEach(batch => {
      const machineId = batch.machineId;
      if (!batchesByMachine[machineId]) {
        batchesByMachine[machineId] = [];
      }
      batchesByMachine[machineId].push(batch);
    });

    console.log(`📊 [DEBUG-AUTO-UPLOAD] Batches grouped by ${Object.keys(batchesByMachine).length} machines`);

    const debugResults = [];

    // 4. Debug từng machine/shop
    for (const [machineId, batches] of Object.entries(batchesByMachine)) {
      console.log(`\n🔍 [DEBUG-AUTO-UPLOAD] === DEBUGGING SHOP: ${machineId} ===`);
      
      // Kiểm tra room cho shop này
      const targetRoom = `machine:${machineId}`;
      const roomClients = io?.sockets?.adapter?.rooms?.get(targetRoom);
      const clientCount = roomClients ? roomClients.size : 0;
      const socketIds = roomClients ? Array.from(roomClients) : [];

      console.log(`🏠 [DEBUG-AUTO-UPLOAD] Room: ${targetRoom}`);
      console.log(`👥 [DEBUG-AUTO-UPLOAD] Clients in room: ${clientCount}`);
      console.log(`🆔 [DEBUG-AUTO-UPLOAD] Socket IDs: ${socketIds.join(', ') || 'none'}`);

      // Kiểm tra từng socket trong room
      const socketDetails = [];
      if (socketIds.length > 0) {
        socketIds.forEach(socketId => {
          const socket = io.sockets.sockets.get(socketId);
          if (socket) {
            socketDetails.push({
              id: socketId,
              connected: socket.connected,
              rooms: Array.from(socket.rooms),
              data: socket.data || {},
              handshake: {
                address: socket.handshake.address,
                headers: Object.keys(socket.handshake.headers)
              }
            });
            console.log(`   Socket ${socketId}:`, {
              connected: socket.connected,
              rooms: Array.from(socket.rooms),
              shopId: socket.data?.shopId,
              machineId: socket.data?.machineId
            });
          }
        });
      }

      const shopDebugInfo = {
        machineId,
        targetRoom,
        clientCount,
        socketIds,
        socketDetails,
        batchCount: batches.length,
        batchIds: batches.map(b => b._id)
      };

      debugResults.push(shopDebugInfo);

      if (jobLog) {
        await jobLog.addLog('info', `Shop debug analysis: ${machineId}`, shopDebugInfo);
      }

      // Test emit (dry run)
      if (clientCount > 0) {
        console.log(`📡 [DEBUG-AUTO-UPLOAD] Testing emit to ${targetRoom}...`);
        
        const testTask = {
          type: "DEBUG_TEST",
          payload: {
            message: "Debug test from auto upload tracking",
            timestamp: new Date().toISOString(),
            machineId,
            batchCount: batches.length
          }
        };

        const emitResult = io.to(targetRoom).emit("server:task", testTask);
        console.log(`📡 [DEBUG-AUTO-UPLOAD] Test emit result: ${emitResult}`);

        if (jobLog) {
          await jobLog.addLog('info', `Test emit sent to ${targetRoom}`, {
            targetRoom,
            clientCount,
            emitResult: typeof emitResult,
            testTask
          });
        }
      } else {
        console.log(`⚠️  [DEBUG-AUTO-UPLOAD] No clients to test emit`);
        
        if (jobLog) {
          await jobLog.addLog('warning', `No clients in room ${targetRoom}`, {
            targetRoom,
            clientCount: 0,
            reason: 'Extension not connected or not joined correct room'
          });
        }
      }
    }

    const endTime = new Date();
    const duration = endTime - startTime;

    console.log(`✅ [DEBUG-AUTO-UPLOAD][${endTime.toISOString()}] Debug completed`);
    console.log(`⏱️  [DEBUG-AUTO-UPLOAD] Duration: ${duration}ms`);

    if (jobLog) {
      await jobLog.addLog('info', 'Debug auto upload tracking completed', {
        endTime: endTime.toISOString(),
        duration,
        shopsAnalyzed: Object.keys(batchesByMachine).length,
        totalBatches: uploadableBatches.length
      });

      await jobLog.setSuccess({
        message: `Debug completed: analyzed ${Object.keys(batchesByMachine).length} shops`,
        processed: uploadableBatches.length,
        results: debugResults,
        duration: `${duration}ms`
      }, {
        processed: uploadableBatches.length,
        success: debugResults.length,
        failed: 0,
        details: {
          shopsAnalyzed: Object.keys(batchesByMachine).length,
          socketsFound: debugResults.reduce((sum, shop) => sum + shop.clientCount, 0)
        }
      });
    }

    return res.json({
      ok: true,
      message: `Debug completed: analyzed ${Object.keys(batchesByMachine).length} shops`,
      processed: uploadableBatches.length,
      results: debugResults,
      duration: `${duration}ms`,
      summary: {
        shopsAnalyzed: Object.keys(batchesByMachine).length,
        totalBatches: uploadableBatches.length,
        socketsFound: debugResults.reduce((sum, shop) => sum + shop.clientCount, 0)
      }
    });

  } catch (error) {
    const endTime = new Date();
    const duration = endTime - startTime;

    console.error(`❌ [DEBUG-AUTO-UPLOAD][${endTime.toISOString()}] Failed after ${duration}ms`);
    console.error(`❌ [DEBUG-AUTO-UPLOAD] Error: ${error.message}`);

    if (jobLog) {
      try {
        await jobLog.addLog('error', 'Debug auto upload tracking failed', {
          endTime: endTime.toISOString(),
          duration,
          error: {
            message: error.message,
            stack: error.stack
          }
        });
        
        await jobLog.setError(error);
      } catch (logError) {
        console.error('❌ Failed to log debug error to database:', logError.message);
      }
    }

    return res.status(500).json({
      ok: false,
      message: error.message,
      duration: `${duration}ms`
    });
  }
};

/**
 * ✅ Sync order status cho một shop cụ thể và lưu vào database
 */
const syncOrderStatusForShop = async (req, res, next) => {
  try {
    const { machineId } = req.params;
    const {
      limit = 1000,
      fromDate,
      toDate,
      status = ["New", "Processing", "Shipped"],
      filterType = "all"
    } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    console.log(`🔄 [SYNC_API] Starting manual sync for shop: ${machineId}`);

    const result = await OrderStatusSyncService.syncOrderStatusForShop(machineId, {
      limit: Number(limit),
      fromDate,
      toDate,
      status: Array.isArray(status) ? status : [status],
      filterType,
      syncType: 'manual'
    });

    console.log(`✅ [SYNC_API] Manual sync completed for shop: ${machineId}`);

    return res.json({
      success: true,
      message: `Order status synced successfully for shop ${machineId}`,
      data: result
    });

  } catch (error) {
    console.error(`❌ [SYNC_API] Error syncing shop ${req.params.machineId}:`, error);
    next(error);
  }
};

/**
 * ✅ Lấy danh sách snapshots cho một shop
 */
const getOrderStatusSnapshots = async (req, res, next) => {
  try {
    const { machineId } = req.params;
    const {
      limit = 10,
      fromDate,
      toDate,
      syncType,
      includeOrders = false
    } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    const filter = { machineId };
    
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = new Date(fromDate);
      if (toDate) filter.createdAt.$lte = new Date(toDate);
    }
    
    if (syncType) {
      filter.syncType = syncType;
    }

    let query = OrderStatusSnapshot.find(filter)
      .sort({ createdAt: -1 })
      .limit(Number(limit));

    // Nếu không cần orders array thì exclude để tăng performance
    if (includeOrders !== 'true') {
      query = query.select('-orders');
    }

    const snapshots = await query.lean();

    return res.json({
      success: true,
      data: snapshots,
      totalCount: snapshots.length,
      filter: {
        machineId,
        limit: Number(limit),
        fromDate,
        toDate,
        syncType,
        includeOrders
      }
    });

  } catch (error) {
    console.error(`❌ [SNAPSHOTS_API] Error getting snapshots for shop ${req.params.machineId}:`, error);
    next(error);
  }
};

/**
 * ✅ Lấy snapshot mới nhất cho một shop
 */
const getLatestOrderStatusSnapshot = async (req, res, next) => {
  try {
    const { machineId } = req.params;
    const { filterType = 'all', includeOrders = true } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    let query = OrderStatusSnapshot.findOne({
      machineId,
      'filterConfig.filterType': filterType,
      isSuccess: true
    }).sort({ createdAt: -1 });

    // Nếu không cần orders array thì exclude
    if (includeOrders !== 'true') {
      query = query.select('-orders');
    }

    const snapshot = await query.lean();

    if (!snapshot) {
      return res.status(404).json({
        success: false,
        message: `No snapshots found for shop ${machineId} with filterType ${filterType}`
      });
    }

    return res.json({
      success: true,
      data: snapshot
    });

  } catch (error) {
    console.error(`❌ [LATEST_SNAPSHOT_API] Error getting latest snapshot for shop ${req.params.machineId}:`, error);
    next(error);
  }
};

/**
 * ✅ Mode 1: Snapshot Only - Chỉ lấy từ snapshot
 */
const checkOrdersStatusFromSnapshot = async (machineId, options) => {
  const { limit, fromDate, toDate, status, filterType } = options;
  
  console.log(`📸 [SNAPSHOT_ONLY] Getting data from snapshot for shop: ${machineId}`);
  
  // Tìm snapshot mới nhất
  const latestSnapshot = await OrderStatusSnapshot.findOne({
    machineId,
    'filterConfig.filterType': filterType,
    isSuccess: true
  }).sort({ createdAt: -1 }).lean();
  
  if (!latestSnapshot) {
    console.log(`⚠️ [SNAPSHOT_ONLY] No snapshot found for shop: ${machineId}`);
    return {
      orders: [],
      totalCount: 0,
      dataSource: 'snapshot',
      snapshotAge: null,
      filter: { machineId, limit, fromDate, toDate, status, filterType },
    };
  }
  
  const snapshotAge = Date.now() - new Date(latestSnapshot.createdAt).getTime();
  console.log(`📊 [SNAPSHOT_ONLY] Using snapshot from ${Math.round(snapshotAge/1000/60)} minutes ago`);
  
  // Apply additional filters if needed
  let filteredOrders = latestSnapshot.orders;
  
  // Filter by date range if specified
  if (fromDate || toDate) {
    filteredOrders = filteredOrders.filter(order => {
      const orderDate = new Date(order.createdAt);
      if (fromDate && orderDate < new Date(fromDate)) return false;
      if (toDate && orderDate > new Date(toDate)) return false;
      return true;
    });
  }
  
  // Apply limit
  if (limit && filteredOrders.length > limit) {
    filteredOrders = filteredOrders.slice(0, limit);
  }
  
  return {
    orders: filteredOrders,
    totalCount: filteredOrders.length,
    stats: latestSnapshot.stats,
    dataSource: 'snapshot',
    snapshotId: latestSnapshot.snapshotId,
    snapshotAge: Math.round(snapshotAge/1000/60), // minutes
    snapshotCreatedAt: latestSnapshot.createdAt,
    filter: { machineId, limit, fromDate, toDate, status, filterType },
  };
};

/**
 * ✅ Mode 2: Hybrid - Snapshot + Real-time cho orders mới
 */
const checkOrdersStatusHybrid = async (machineId, options) => {
  const { limit, fromDate, toDate, status, filterType } = options;
  
  console.log(`🔄 [HYBRID] Starting hybrid mode for shop: ${machineId}`);
  
  // 1. Lấy snapshot mới nhất
  const latestSnapshot = await OrderStatusSnapshot.findOne({
    machineId,
    'filterConfig.filterType': filterType,
    isSuccess: true
  }).sort({ createdAt: -1 }).lean();
  
  if (!latestSnapshot) {
    console.log(`⚠️ [HYBRID] No snapshot found, falling back to real-time`);
    return await checkOrdersStatusRealTime(machineId, options);
  }
  
  const snapshotAge = Date.now() - new Date(latestSnapshot.createdAt).getTime();
  const snapshotAgeMinutes = Math.round(snapshotAge/1000/60);
  
  console.log(`📊 [HYBRID] Using snapshot from ${snapshotAgeMinutes} minutes ago`);
  
  // 2. Nếu snapshot quá cũ (>30 phút), query real-time
  if (snapshotAgeMinutes > 30) {
    console.log(`⏰ [HYBRID] Snapshot too old (${snapshotAgeMinutes}min), using real-time`);
    return await checkOrdersStatusRealTime(machineId, options);
  }
  
  // 3. Lấy orders mới từ thời điểm snapshot
  const snapshotDate = new Date(latestSnapshot.createdAt);
  const newOrdersFilter = {
    status: { $in: Array.isArray(status) ? status : [status] },
    shopId: machineId,
    createdAt: { $gt: snapshotDate }
  };
  
  const newOrders = await OrderCustomProduct.find(newOrdersFilter)
    .populate('shopId', 'name store')
    .sort({ createdAt: -1 })
    .lean();
  
  console.log(`🆕 [HYBRID] Found ${newOrders.length} new orders since snapshot`);
  
  // 4. Process new orders nếu có
  let newOrdersProcessed = [];
  if (newOrders.length > 0) {
    newOrdersProcessed = await processOrdersForHybrid(newOrders, machineId);
  }
  
  // 5. Merge snapshot orders + new orders
  let allOrders = [...latestSnapshot.orders, ...newOrdersProcessed];
  
  // 6. Apply filters
  let filteredOrders = allOrders;
  
  // Filter by date range
  if (fromDate || toDate) {
    filteredOrders = filteredOrders.filter(order => {
      const orderDate = new Date(order.createdAt);
      if (fromDate && orderDate < new Date(fromDate)) return false;
      if (toDate && orderDate > new Date(toDate)) return false;
      return true;
    });
  }
  
  // Apply limit
  if (limit && filteredOrders.length > limit) {
    filteredOrders = filteredOrders.slice(0, limit);
  }
  
  // 7. Recalculate stats
  const stats = {
    totalScanned: allOrders.length,
    totalWithTracking: allOrders.filter(o => o.hasTracking).length,
    totalWithoutTracking: allOrders.filter(o => !o.hasTracking).length,
    totalSubmitted: allOrders.filter(o => o.submittedToAmazon).length,
    totalNotSubmitted: allOrders.filter(o => o.hasTracking && !o.submittedToAmazon).length,
    filteredCount: filteredOrders.length,
  };
  
  return {
    orders: filteredOrders,
    totalCount: filteredOrders.length,
    stats,
    dataSource: 'hybrid',
    snapshotId: latestSnapshot.snapshotId,
    snapshotAge: snapshotAgeMinutes,
    newOrdersCount: newOrders.length,
    filter: { machineId, limit, fromDate, toDate, status, filterType },
  };
};

/**
 * ✅ Mode 3: Snapshot Priority - Ưu tiên snapshot, fallback real-time
 */
const checkOrdersStatusSnapshotPriority = async (machineId, options) => {
  console.log(`📸 [SNAPSHOT_PRIORITY] Trying snapshot first for shop: ${machineId}`);
  
  try {
    const snapshotResult = await checkOrdersStatusFromSnapshot(machineId, options);
    
    if (snapshotResult.orders.length > 0) {
      console.log(`✅ [SNAPSHOT_PRIORITY] Using snapshot data (${snapshotResult.orders.length} orders)`);
      return { ...snapshotResult, dataSource: 'snapshot-priority' };
    }
  } catch (error) {
    console.log(`⚠️ [SNAPSHOT_PRIORITY] Snapshot failed, falling back to real-time:`, error.message);
  }
  
  console.log(`🔄 [SNAPSHOT_PRIORITY] Falling back to real-time`);
  const realTimeResult = await checkOrdersStatusRealTime(machineId, options);
  return { ...realTimeResult, dataSource: 'snapshot-priority-fallback' };
};

/**
 * ✅ Mode 4: Real-time - Logic gốc
 */
const checkOrdersStatusRealTime = async (machineId, options) => {
  const { limit, fromDate, toDate, status, filterType } = options;
  
  console.log(`⚡ [REAL_TIME] Using real-time query for shop: ${machineId}`);
  
  // Logic gốc của checkOrdersStatus
  const orderFilter = {
    status: { $in: Array.isArray(status) ? status : [status] },
    shopId: machineId,
  };

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

  const allOrders = await OrderCustomProduct.find(orderFilter)
    .populate('shopId', 'name store')
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean();

  if (!allOrders.length) {
    return {
      orders: [],
      totalCount: 0,
      dataSource: 'real-time',
      filter: { machineId, limit, fromDate, toDate, status, filterType },
    };
  }

  // Process orders (logic gốc)
  const ordersWithDetails = [];
  for (const order of allOrders) {
    let hasValidTracking = false;
    let tracking = "";
    let trackingInfo = null;

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
      shopId: order.shopId?._id || order.shopId,
      shopName: order.shopId?.name || null,
      shopStore: order.shopId?.store || null,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      hasTracking: hasValidTracking,
      tracking: tracking || null,
      trackingInfo: trackingInfo,
      itemsCount: (order.items || []).length,
      customerEmail: order.customer?.email || null,
      totalAmount: order.total_amount || 0,
    });
  }

  // Check submission status
  const allOrderIds = ordersWithDetails.map(o => o.orderId);
  const submittedBatches = await ShippingBatch.find({
    machineId,
    "completed.orderId": { $in: allOrderIds },
  }).lean();

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

  const finalOrders = ordersWithDetails.map(order => ({
    ...order,
    submittedToAmazon: submissionMap.has(order.orderId),
    submissionInfo: submissionMap.get(order.orderId) || null,
  }));

  // Apply filterType
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
  }

  const stats = {
    totalScanned: allOrders.length,
    totalWithTracking: finalOrders.filter(o => o.hasTracking).length,
    totalWithoutTracking: finalOrders.filter(o => !o.hasTracking).length,
    totalSubmitted: finalOrders.filter(o => o.submittedToAmazon).length,
    totalNotSubmitted: finalOrders.filter(o => o.hasTracking && !o.submittedToAmazon).length,
    filteredCount: filteredOrders.length,
  };

  return {
    orders: filteredOrders,
    totalCount: filteredOrders.length,
    stats,
    dataSource: 'real-time',
    filter: { machineId, limit, fromDate, toDate, status, filterType },
  };
};

/**
 * Helper function để process orders cho hybrid mode
 */
const processOrdersForHybrid = async (orders, machineId) => {
  const ordersWithDetails = [];
  
  for (const order of orders) {
    let hasValidTracking = false;
    let tracking = "";
    let trackingInfo = null;

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
      shopId: order.shopId?._id || order.shopId,
      shopName: order.shopId?.name || null,
      shopStore: order.shopId?.store || null,
      status: order.status,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      hasTracking: hasValidTracking,
      tracking: tracking || null,
      trackingInfo: trackingInfo,
      itemsCount: (order.items || []).length,
      customerEmail: order.customer?.email || null,
      totalAmount: order.total_amount || 0,
    });
  }
  
  // Check submission status for new orders
  const allOrderIds = ordersWithDetails.map(o => o.orderId);
  const submittedBatches = await ShippingBatch.find({
    machineId,
    "completed.orderId": { $in: allOrderIds },
  }).lean();

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

  return ordersWithDetails.map(order => ({
    ...order,
    submittedToAmazon: submissionMap.has(order.orderId),
    submissionInfo: submissionMap.get(order.orderId) || null,
  }));
};

/**
 * ✅ Chạy sync thủ công cho tất cả shops
 */
const runOrderStatusSyncManually = async (req, res, next) => {
  try {
    const {
      limit = 1000,
      status = ["New", "Processing", "Shipped"],
      filterType = "all"
    } = req.body;

    console.log(`🔄 [MANUAL_SYNC_ALL] Starting manual sync for all active shops`);

    const result = await OrderStatusSyncService.syncAllActiveShops({
      limit: Number(limit),
      status: Array.isArray(status) ? status : [status],
      filterType,
      syncType: 'manual'
    });

    console.log(`✅ [MANUAL_SYNC_ALL] Manual sync completed: ${result.successCount}/${result.totalShops} shops`);

    return res.json({
      success: true,
      message: `Synced ${result.successCount}/${result.totalShops} shops successfully`,
      data: result
    });

  } catch (error) {
    console.error(`❌ [MANUAL_SYNC_ALL] Error in manual sync all:`, error);
    next(error);
  }
};

/**
 * ✅ Bulk sync submission status cho một shop
 */
const bulkSyncSnapshotSubmissionStatus = async (req, res, next) => {
  try {
    const { machineId } = req.params;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    console.log(`🔄 [BULK_SYNC_API] Starting bulk sync for shop: ${machineId}`);

    const result = await SnapshotAutoSyncService.bulkSyncShopSubmissionStatus(machineId);

    console.log(`✅ [BULK_SYNC_API] Bulk sync completed for shop: ${machineId}`);

    return res.json({
      success: true,
      message: `Bulk sync completed: ${result.updated}/${result.totalSnapshots} snapshots updated`,
      data: result
    });

  } catch (error) {
    console.error(`❌ [BULK_SYNC_API] Error in bulk sync for shop ${req.params.machineId}:`, error);
    next(error);
  }
};

/**
 * ✅ Cập nhật submission status cho một order cụ thể
 */
const updateOrderSubmissionStatusManually = async (req, res, next) => {
  try {
    const { orderId, machineId } = req.params;
    const { submissionInfo = null } = req.body;

    if (!orderId || !machineId) {
      return res.status(400).json({ message: "orderId and machineId are required" });
    }

    console.log(`🔄 [UPDATE_ORDER_API] Updating submission status for order: ${orderId} in shop: ${machineId}`);

    const result = await SnapshotAutoSyncService.updateOrderSubmissionStatus(
      orderId, 
      machineId, 
      submissionInfo
    );

    console.log(`✅ [UPDATE_ORDER_API] Order submission status updated: ${orderId}`);

    return res.json({
      success: true,
      message: `Order ${orderId} submission status updated in ${result.updated} snapshots`,
      data: result
    });

  } catch (error) {
    console.error(`❌ [UPDATE_ORDER_API] Error updating order ${req.params.orderId}:`, error);
    next(error);
  }
};

/**
 * ✅ Bulk remove orders from submission status (set submittedToAmazon = false)
 * POST /api/shipping-batch/bulk-remove-submission
 * Body: {
 *   machineId: string,
 *   orderIds: string[],
 *   reason?: string
 * }
 */
const bulkRemoveOrdersFromSubmission = async (req, res, next) => {
  try {
    const { machineId, orderIds = [], reason = "Manual removal" } = req.body;

    if (!machineId) {
      return res.status(400).json({
        success: false,
        message: "machineId is required"
      });
    }

    if (!orderIds.length) {
      return res.status(400).json({
        success: false,
        message: "orderIds array is required and cannot be empty"
      });
    }

    console.log(`🔄 [BULK_REMOVE] Removing ${orderIds.length} orders from submission status for shop: ${machineId}`);
    console.log(`📋 [BULK_REMOVE] Orders: ${orderIds.join(', ')}`);

    // 1. Find all batches containing these orders
    const affectedBatches = await ShippingBatch.find({
      machineId,
      "completed.orderId": { $in: orderIds }
    });

    console.log(`📊 [BULK_REMOVE] Found ${affectedBatches.length} batches containing these orders`);

    if (!affectedBatches.length) {
      return res.json({
        success: true,
        message: "No batches found containing these orders - they may already be unsubmitted",
        processed: 0,
        results: []
      });
    }

    const results = [];
    let totalRemoved = 0;

    // 2. Process each batch
    for (const batch of affectedBatches) {
      const originalCompletedCount = batch.completed.length;
      const originalFakeCount = batch.tracking_fakes.length;

      // Remove orders from completed array
      const removedOrders = [];
      batch.completed = batch.completed.filter(completed => {
        if (orderIds.includes(completed.orderId)) {
          removedOrders.push(completed);
          return false; // Remove from completed
        }
        return true; // Keep in completed
      });

      // Add removed orders to tracking_fakes (if they had tracking)
      for (const removedOrder of removedOrders) {
        if (removedOrder.tracking && !removedOrder.isFake) {
          batch.tracking_fakes.push({
            orderId: removedOrder.orderId,
            tracking: removedOrder.tracking,
            note: `Removed from submission: ${reason}`,
            removedAt: new Date(),
            originalBatchId: batch._id
          });
        }
      }

      // Update stats
      batch.stats.totalOrders = batch.completed.length;
      batch.stats.totalReal = batch.completed.filter(c => !c.isFake).length;
      batch.stats.totalFake = batch.tracking_fakes.length;

      // Add removal log
      if (!batch.removalLog) batch.removalLog = [];
      batch.removalLog.push({
        removedAt: new Date(),
        removedBy: "bulk_api",
        reason,
        removedOrderIds: removedOrders.map(o => o.orderId),
        removedCount: removedOrders.length
      });

      await batch.save();

      results.push({
        batchId: batch._id,
        batchLabel: batch.label,
        batchType: batch.type,
        originalCompletedCount,
        newCompletedCount: batch.completed.length,
        removedCount: removedOrders.length,
        removedOrders: removedOrders.map(o => ({
          orderId: o.orderId,
          tracking: o.tracking,
          isFake: o.isFake
        }))
      });

      totalRemoved += removedOrders.length;
    }

    // 3. Update snapshots to reflect the changes
    try {
      console.log(`🔄 [BULK_REMOVE] Updating snapshots for shop: ${machineId}`);
      await SnapshotAutoSyncService.bulkSyncShopSubmissionStatus(machineId);
    } catch (syncError) {
      console.error(`⚠️ [BULK_REMOVE] Failed to sync snapshots:`, syncError.message);
    }

    // 4. Log the bulk removal
    await RealtimeLog.create({
      machineId,
      label: "Bulk Remove Submission",
      action: "bulk_remove",
      level: "info",
      message: `Bulk removed ${totalRemoved} orders from submission status. Reason: ${reason}`,
      ts: new Date(),
    });

    console.log(`✅ [BULK_REMOVE] Successfully removed ${totalRemoved} orders from ${affectedBatches.length} batches`);

    return res.json({
      success: true,
      message: `Successfully removed ${totalRemoved} orders from submission status`,
      processed: totalRemoved,
      affectedBatches: affectedBatches.length,
      results,
      summary: {
        totalOrdersRequested: orderIds.length,
        totalOrdersRemoved: totalRemoved,
        batchesModified: affectedBatches.length,
        reason
      }
    });

  } catch (error) {
    console.error(`❌ [BULK_REMOVE] Error in bulk remove submission:`, error);
    next(error);
  }
};

/**
 * ✅ Check which orders are currently submitted (for verification)
 * POST /api/shipping-batch/check-submission-status
 * Body: {
 *   machineId: string,
 *   orderIds: string[]
 * }
 */
const checkOrdersSubmissionStatus = async (req, res, next) => {
  try {
    const { machineId, orderIds = [] } = req.body;

    if (!machineId || !orderIds.length) {
      return res.status(400).json({
        success: false,
        message: "machineId and orderIds are required"
      });
    }

    console.log(`� [CHECK_SUBMInSSION] Checking submission status for ${orderIds.length} orders in shop: ${machineId}`);

    // Find batches containing these orders
    const submittedBatches = await ShippingBatch.find({
      machineId,
      "completed.orderId": { $in: orderIds }
    }).lean();

    const submissionMap = new Map();
    const batchInfo = new Map();

    for (const batch of submittedBatches) {
      for (const completed of batch.completed || []) {
        if (orderIds.includes(completed.orderId)) {
          submissionMap.set(completed.orderId, {
            submittedToAmazon: true,
            batchId: batch._id,
            batchType: batch.type,
            batchLabel: batch.label,
            submittedAt: batch.createdAt,
            tracking: completed.tracking,
            isFake: completed.isFake
          });

          if (!batchInfo.has(batch._id.toString())) {
            batchInfo.set(batch._id.toString(), {
              batchId: batch._id,
              batchLabel: batch.label,
              batchType: batch.type,
              createdAt: batch.createdAt,
              ordersInBatch: []
            });
          }
          batchInfo.get(batch._id.toString()).ordersInBatch.push(completed.orderId);
        }
      }
    }

    const results = orderIds.map(orderId => ({
      orderId,
      submittedToAmazon: submissionMap.has(orderId),
      submissionInfo: submissionMap.get(orderId) || null
    }));

    const summary = {
      totalChecked: orderIds.length,
      submitted: results.filter(r => r.submittedToAmazon).length,
      notSubmitted: results.filter(r => !r.submittedToAmazon).length,
      batchesFound: batchInfo.size
    };

    return res.json({
      success: true,
      results,
      summary,
      batches: Array.from(batchInfo.values())
    });

  } catch (error) {
    console.error(`❌ [CHECK_SUBMISSION] Error checking submission status:`, error);
    next(error);
  }
};

// ✅ Cập nhật exports
module.exports = {
  createBatchFromFile,
  listShippingBatches,
  createUpdateBatchFromSystem,
  downloadCompletedFile,
  // updateAllFakeTracking, // COMMENTED OUT - removed fake tracking
  downloadAllUpdatedFakeFile,
  exportOrdersWithTracking,
  checkOrdersStatus,
  manualUploadTask,
  getUploadableBatches,
  createBatchFromOrders, // ✅ API mới cho FE
  autoUploadTracking, // ✅ API auto upload từ snapshots
  getAutoUploadStatus, // ✅ API kiểm tra trạng thái auto upload
  
  // ✅ Order Status Sync APIs
  syncOrderStatusForShop,
  getOrderStatusSnapshots,
  getLatestOrderStatusSnapshot,
  runOrderStatusSyncManually,
  
  // ✅ Snapshot Auto Sync APIs
  bulkSyncSnapshotSubmissionStatus,
  updateOrderSubmissionStatusManually,
  
  // ✅ NEW: Bulk submission management APIs
  bulkRemoveOrdersFromSubmission,
  checkOrdersSubmissionStatus,
  quickRemoveOrderFromBatches
};