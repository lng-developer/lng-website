const db = require("../models");
const ShippingBatch = db.ShippingBatch;
const OrderCustomProduct = db.orderCustomProduct;
const RealtimeLog = db.RealtimeLog;

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
    } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    // 1. Build query filter cho orders
    const orderFilter = {
      status: { $in: Array.isArray(status) ? status : [status] },
      shopId: machineId, // ✅ Filter orders theo shopId = machineId
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

    // 2. Query tất cả orders theo filter (shopId = machineId)
    const allOrders = await OrderCustomProduct.find(orderFilter)
      .populate('shopId', 'name store') // ✅ Populate shop info
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();

    console.log(`🔍 [CHECK_ORDERS] Filtering orders for shopId: ${machineId}`);
    console.log(`📊 [CHECK_ORDERS] Found ${allOrders.length} orders for shop ${machineId}`);

    if (!allOrders.length) {
      console.log(`⚠️ [CHECK_ORDERS] No orders found for shopId: ${machineId}`);
      return res.json({
        orders: [],
        totalCount: 0,
        filter: {
          machineId,
          shopId: machineId, // ✅ Thêm shopId vào response để rõ ràng
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
        shopId: machineId, // ✅ Thêm shopId vào response
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
  // updateAllFakeTracking, // COMMENTED OUT - removed fake tracking
  downloadAllUpdatedFakeFile,
  exportOrdersWithTracking,
  checkOrdersStatus, // ✅ Thêm function mới
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
  sendUploadTrackingTask, // ✅ Thêm function mới
};

// ✅ Cập nhật exports - chỉ giữ các function cần thiết
module.exports = {
  createBatchFromFile,
  listShippingBatches,
  createUpdateBatchFromSystem,
  downloadCompletedFile,
  // updateAllFakeTracking, // COMMENTED OUT - removed fake tracking
  downloadAllUpdatedFakeFile,
  exportOrdersWithTracking,
  checkOrdersStatus,
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

// ✅ Cập nhật exports với API mới cho FE
module.exports = {
  createBatchFromFile,
  listShippingBatches,
  createUpdateBatchFromSystem,
  downloadCompletedFile,
  // updateAllFakeTracking, // COMMENTED OUT - removed fake tracking
  downloadAllUpdatedFakeFile,
  exportOrdersWithTracking,
  checkOrdersStatus,
  manualUploadTask, // ✅ API manual cho FE
  getUploadableBatches, // ✅ API lấy danh sách batch có thể upload
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
    console.log(`📊 [CREATE_BATCH] Found ${shopIds.length} shops:`, shopIds.map(shopId => `${shopId}(${ordersByShop[shopId].length} orders)`));

    const createdBatches = [];
    const results = [];

    // ✅ Tạo batch riêng cho từng shopId
    for (const shopId of shopIds) {
      const shopOrderIds = ordersByShop[shopId];
      
      try {
        console.log(`🔄 [CREATE_BATCH] Processing shop ${shopId} with ${shopOrderIds.length} orders`);

        // Lấy thông tin orders từ DB cho shop này
        const shopOrders = await OrderCustomProduct.find({
          orderId: { $in: shopOrderIds },
          shopId: shopId
        }).lean();

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

        const completed = [];
        const tracking_fakes = [];
        let totalReal = 0;
        let totalFake = 0;

        // Xử lý từng order của shop này
        for (const order of shopOrders) {
          const orderId = order.orderId;
          
          // Lấy tracking từ order
          const realTracking = await getRealTrackingForOrder(orderId);
          
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
            // ❌ Không có tracking → chỉ lưu vào tracking_fakes để theo dõi, không tạo fake tracking
            /* COMMENTED OUT - removed fake tracking logic
            const fakeTracking = generateFakeTracking();
            
            // Thêm vào completed với fake tracking
            completed.push({
              orderId,
              tracking: fakeTracking,
              isFake: true,
              source: "fake",
              createdAt: new Date()
            });
            */
            
            // Thêm vào tracking_fakes để theo dõi (không có tracking)
            tracking_fakes.push({
              orderId,
              // tracking: fakeTracking, // REMOVED
              note: "No real tracking available", // Updated note
              createdAt: new Date()
            });
            
            totalFake++;
          }
        }

        // Lấy shop name để làm label
        const shopInfo = shopOrders[0]; // Lấy thông tin shop từ order đầu tiên
        const shopName = shopInfo.shopName || shopInfo.shopStore || `Shop ${shopId}`;
        const batchLabel = label ? `${label} - ${shopName}` : `FE Batch - ${shopName}`;

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

        createdBatches.push(batch);

        console.log(`✅ [CREATE_BATCH] Created batch ${batch._id} for shop ${shopId} with ${completed.length} orders (${totalReal} real, ${totalFake} fake)`);

        // ✅ Tự động gửi upload task nếu có real tracking và autoUpload = true
        let autoTaskSent = false;
        if (autoUpload && totalReal > 0) {
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

              // Gửi task
              console.log(`📡 [DEBUG] Emitting task to room: ${roomName}`);
              console.log(`📦 [DEBUG] Task payload:`, {
                type: task.type,
                batchId: task.payload.batchId.toString(),
                machineId: task.payload.machineId,
                shopId: task.payload.shopId,
                trackingCount: task.payload.trackingData.length
              });
              
              io.to(`machine:${machineId}`).emit("server:task", task);
              console.log(`✅ [DEBUG] Task emitted to ${roomSockets.length} sockets in room ${roomName}`);

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
                message: `Created batch from FE orders and sent upload task: ${completed.length} orders for shop ${shopName}`,
                ts: new Date(),
              });

              console.log(`✅ [CREATE_BATCH] Auto sent upload task for batch ${batch._id} (shop: ${shopName})`);
            }
          } catch (taskError) {
            console.error(`❌ [CREATE_BATCH] Failed to send auto upload task for shop ${shopId}:`, taskError.message);
          }
        }

        results.push({
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
        });

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
    const totalOrdersProcessed = results.reduce((sum, r) => sum + (r.totalOrders || 0), 0);

    return res.status(201).json({
      ok: true,
      totalShops: shopIds.length,
      successfulBatches: successCount,
      failedBatches: shopIds.length - successCount,
      totalOrdersProcessed,
      batches: results,
      message: `Created ${successCount} batches for ${shopIds.length} shops with ${totalOrdersProcessed} total orders`
    });

  } catch (err) {
    next(err);
  }
};

/**
 * Auto upload tracking - Tự động upload batches có tracking lên Amazon
 * Dựa trên logic checkOrdersStatus để tìm batches cần upload
 */
const autoUploadTracking = async (req, res, next) => {
  const startTime = new Date();
  const isAutoCall = !req.headers['user-agent']; // Auto calls không có user-agent
  
  try {
    const {
      maxBatches = 10,
      dryRun = false,
      carrierCode = "USPS",
      shipMethod = "USPS First Class"
    } = req.body || {};

    console.log(`🚀 [AUTO-UPLOAD][${startTime.toISOString()}] Starting auto upload tracking`);
    console.log(`📋 [AUTO-UPLOAD] Type: ${isAutoCall ? '🤖 AUTO' : '👤 MANUAL'}`);
    console.log(`⚙️  [AUTO-UPLOAD] Settings: maxBatches=${maxBatches}, dryRun=${dryRun}`);

    // 1. Tìm tất cả batches có thể upload
    const uploadableBatches = await ShippingBatch.find({
      status: 'CONFIRM_FILE_READY',
      completed: { $exists: true, $ne: [] },
      uploadTaskSent: { $ne: true }, // Chưa gửi task
      machineId: { $exists: true, $ne: null } // Phải có machineId
    })
    .sort({ createdAt: 1 }) // Upload batches cũ trước
    .limit(maxBatches)
    .lean();

    console.log(`📊 [AUTO-UPLOAD] Found ${uploadableBatches.length} uploadable batches`);

    if (uploadableBatches.length === 0) {
      console.log(`✅ [AUTO-UPLOAD] No batches to upload`);
      return res.json({
        ok: true,
        message: "No batches found for auto upload",
        processed: 0,
        results: []
      });
    }

    // 2. Group batches theo machineId (shopId)
    const batchesByMachine = {};
    uploadableBatches.forEach(batch => {
      const machineId = batch.machineId;
      if (!batchesByMachine[machineId]) {
        batchesByMachine[machineId] = [];
      }
      batchesByMachine[machineId].push(batch);
    });

    console.log(`📊 [AUTO-UPLOAD] Batches grouped by ${Object.keys(batchesByMachine).length} machines`);

    const results = [];
    let successCount = 0;
    let failCount = 0;

    const io = req.app.get("io");
    if (!io) {
      console.error(`❌ [AUTO-UPLOAD] Socket.IO not available`);
      return res.status(500).json({ 
        ok: false, 
        message: "Socket.IO not available" 
      });
    }

    // 3. Process từng machine
    for (const [machineId, batches] of Object.entries(batchesByMachine)) {
      console.log(`🔄 [AUTO-UPLOAD] Processing ${batches.length} batches for machine: ${machineId}`);

      for (const batch of batches) {
        try {
          console.log(`📤 [AUTO-UPLOAD] Processing batch: ${batch._id} (${batch.label})`);

          // Tạo file content
          const shipDateBase = batch.createdAt ? new Date(batch.createdAt) : new Date();
          const shipDateStr = buildShipDateString(shipDateBase);
          const fileContent = buildCompletedShippingFile(batch.completed, {
            carrierCode,
            shipMethod,
            shipDate: shipDateStr,
          });

          const filename = batch.fileName || `auto_upload_${batch._id}.txt`;

          // Chuẩn bị tracking data
          const trackingData = batch.completed.map(item => ({
            orderId: item.orderId,
            tracking: item.tracking,
            isFake: item.isFake || false,
            source: item.source || 'system'
          }));

          // Tạo task payload
          const task = {
            type: "UPLOAD_TRACKING",
            payload: {
              batchId: batch._id,
              machineId: machineId, // ✅ Đảm bảo gửi đúng machineId
              shopId: machineId,    // ✅ shopId = machineId
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
              
              autoGenerated: true,
              reason: "auto_upload_tracking",
              requestedBy: "cron_job",
              timestamp: new Date().toISOString()
            }
          };

          if (!dryRun) {
            // Gửi task đến extension của shop cụ thể
            io.to(`machine:${machineId}`).emit("server:task", task);
            
            // Đánh dấu batch đã gửi task
            await ShippingBatch.updateOne(
              { _id: batch._id },
              {
                uploadTaskSent: true,
                uploadTaskSentAt: new Date(),
                uploadTaskSentBy: "auto_cron"
              }
            );

            // Log vào RealtimeLog
            await RealtimeLog.create({
              shopId: machineId,
              machineId: machineId,
              label: batch.label,
              action: "auto",
              level: "info",
              message: `Auto UPLOAD_TRACKING: ${trackingData.length} orders, file: ${filename}`,
              ts: new Date(),
            });
          }

          results.push({
            batchId: batch._id,
            machineId: machineId,
            shopId: machineId, // ✅ Thêm shopId để rõ ràng
            label: batch.label,
            trackingCount: trackingData.length,
            filename,
            fileSize: Buffer.byteLength(fileContent, 'utf8'),
            success: true,
            dryRun,
            message: dryRun ? "Dry run - task not sent" : "Task sent successfully"
          });

          successCount++;
          console.log(`✅ [AUTO-UPLOAD] Success: ${batch._id} -> machine:${machineId}`);

        } catch (error) {
          console.error(`❌ [AUTO-UPLOAD] Failed batch ${batch._id}:`, error.message);
          
          results.push({
            batchId: batch._id,
            machineId: machineId,
            shopId: machineId,
            label: batch.label,
            success: false,
            error: error.message,
            message: `Failed to process batch: ${error.message}`
          });
          
          failCount++;
        }
      }
    }

    const endTime = new Date();
    const duration = endTime - startTime;

    console.log(`✅ [AUTO-UPLOAD][${endTime.toISOString()}] Completed`);
    console.log(`📊 [AUTO-UPLOAD] Results: success=${successCount}, failed=${failCount}, total=${uploadableBatches.length}`);
    console.log(`⏱️  [AUTO-UPLOAD] Duration: ${duration}ms`);

    return res.json({
      ok: true,
      processed: uploadableBatches.length,
      success: successCount,
      failed: failCount,
      results,
      dryRun,
      duration: `${duration}ms`,
      message: `Auto upload tracking completed: ${successCount} success, ${failCount} failed`
    });

  } catch (error) {
    const endTime = new Date();
    const duration = endTime - startTime;
    
    console.error(`❌ [AUTO-UPLOAD][${endTime.toISOString()}] Failed after ${duration}ms`);
    console.error(`❌ [AUTO-UPLOAD] Error: ${error.message}`);
    
    return res.status(500).json({ 
      ok: false, 
      message: error.message,
      duration: `${duration}ms`
    });
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
  autoUploadTracking // ✅ API mới cho auto upload
};