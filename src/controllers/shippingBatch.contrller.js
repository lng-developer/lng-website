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
    (h) => h === "order-id" || h === '"order-id"'
  );
  const daysPastPromiseIndex = headers.findIndex(
    (h) => h === "days-past-promise" || h === '"days-past-promise"'
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
      if (row.daysPastPromise !== -2) continue; // chỉ lấy -2
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

    // 3) Với mỗi orderId đã lọc: lấy tracking hoặc gen fake
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
        // Đơn chưa có tracking -> gen fake
        const fake = generateFakeTracking(orderId);

        completed.push({
          orderId,
          tracking: fake,
          isFake: true,
          source: "fake",
        });

        tracking_fakes.push({
          orderId,
          tracking: fake,
        });
      }
    }

    // 4) Stats
    const stats = {
      totalOrders: completed.length,
      totalFake: completed.filter((r) => r.isFake).length,
      totalReal: completed.filter((r) => !r.isFake).length,
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
      (c) => c.isFake
    ).length;
    original.stats.totalReal = original.completed.filter(
      (c) => !c.isFake
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
      22
    )
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
    shipDate, // đã build sẵn ở ngoài, không tự build nữa
  } = options;

  let content =
    "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

  for (const item of completed) {
    if (!item.orderId || !item.tracking) continue;

    const orderId = normalizeField(item.orderId);
    const tracking = normalizeField(item.tracking);

    if (!orderId || !tracking) continue;

    content += [orderId, shipDate, carrierCode, tracking, shipMethod].join(
      "\t"
    );

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

function buildShipDateString(baseDate) {
  const ref = new Date(baseDate);

  const shipDate = new Date(
    Date.UTC(
      ref.getUTCFullYear(),
      ref.getUTCMonth(),
      ref.getUTCDate(),
      0,
      22,
      22
    )
  );

  return shipDate.toISOString().replace(".000Z", "+00:00");
}

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

    const batches = await ShippingBatch.find({
      type: "CONFIRM",
      machineId,
      tracking_fakes: { $exists: true, $ne: [] },
    });

    if (!batches.length) {
      return res.status(200).json({
        message: "No batches with fake tracking found",
      });
    }

    const resolvedRows = [];
    let updatedOrderCount = 0;

    for (const batch of batches) {
      const shipDateStr = buildShipDateString(batch.createdAt);

      const remainingFakes = [];

      for (const fakeItem of batch.tracking_fakes) {
        const realTracking = await getRealTrackingForOrder(fakeItem.orderId);

        if (realTracking) {
          // gom vào file update global
          resolvedRows.push({
            orderId: fakeItem.orderId,
            tracking: realTracking,
            shipDate: shipDateStr,
            sourceBatchId: batch._id,
          });

          // update completed trong batch gốc
          const comp = batch.completed.find(
            (c) => c.orderId === fakeItem.orderId
          );
          if (comp) {
            comp.tracking = realTracking;
            comp.isFake = false;
            comp.source = "system";
          }

          updatedOrderCount++;
        } else {
          remainingFakes.push(fakeItem);
        }
      }

      batch.tracking_fakes = remainingFakes;
      batch.stats.totalFake = remainingFakes.length;
      batch.stats.totalReal = batch.completed.length - remainingFakes.length;

      await batch.save();
    }

    if (!resolvedRows.length) {
      return res.status(200).json({
        message: "No real tracking found across all batches",
      });
    }

    // tạo UPDATE_GLOBAL batch
    const updateBatch = await ShippingBatch.create({
      machineId,
      label,
      type: "UPDATE_GLOBAL",
      status: "CONFIRM_FILE_READY",
      completed: resolvedRows.map((r) => ({
        orderId: r.orderId,
        tracking: r.tracking,
        isFake: false,
        source: "system",
      })),
      tracking_fakes: [],
      stats: {
        totalOrders: resolvedRows.length,
        totalFake: 0,
        totalReal: resolvedRows.length,
      },
    });

    const fileContent = buildGlobalUpdateFile(resolvedRows);

    return res.status(201).json({
      updateBatchId: updateBatch._id,
      totalUpdatedOrders: updatedOrderCount,
      fileContent,
    });
  } catch (err) {
    next(err);
  }
};

const downloadAllUpdatedFakeFile = async (req, res, next) => {
  try {
    const {
      machineId,
      carrierCode = "USPS",
      shipMethod = "USPS First Class",
    } = req.query;

    if (!machineId) {
      return res.status(400).json({ message: "machineId is required" });
    }

    // 1) Lấy tất cả batch UPDATE (fake -> real)
    const updateBatches = await ShippingBatch.find({
      type: { $in: ["UPDATE_FAKE", "UPDATE_GLOBAL"] },
      machineId,
      completed: { $exists: true, $ne: [] },
    })
      .sort({ createdAt: 1 })
      .lean(); // lean để xử lý nhanh

    if (!updateBatches.length) {
      return res.status(400).json({
        message: "No updated tracking batches found",
      });
    }

    /**
     * 2) Gom orderId + tracking từ UPDATE batches
     * Nếu trùng orderId nhiều lần, ưu tiên bản mới nhất (vì sort createdAt tăng dần)
     */
    const orderMap = new Map(); // orderId -> tracking
    for (const batch of updateBatches) {
      for (const item of batch.completed || []) {
        if (!item?.orderId || !item?.tracking) continue;
        orderMap.set(String(item.orderId).trim(), String(item.tracking).trim());
      }
    }

    const orderIds = Array.from(orderMap.keys());
    if (!orderIds.length) {
      return res.status(400).json({ message: "No valid updated orders found" });
    }

    /**
     * 3) Tìm batch CONFIRM chứa từng orderId để lấy createdAt của CONFIRM batch
     * Dùng aggregate để tạo map orderId -> confirmCreatedAt
     *
     * Lưu ý: match theo completed.orderId với $in
     */
    const confirmMatches = await ShippingBatch.aggregate([
      {
        $match: {
          type: "CONFIRM",
          machineId,
          "completed.orderId": { $in: orderIds },
        },
      },
      { $unwind: "$completed" },
      { $match: { "completed.orderId": { $in: orderIds } } },
      {
        $group: {
          _id: "$completed.orderId",
          // nếu orderId lỡ xuất hiện nhiều confirm batch, lấy cái sớm nhất hoặc đúng logic bạn muốn
          confirmCreatedAt: { $min: "$createdAt" },
        },
      },
    ]);

    const confirmDateMap = new Map(); // orderId -> createdAt(Date)
    for (const row of confirmMatches) {
      if (!row?._id || !row?.confirmCreatedAt) continue;
      confirmDateMap.set(String(row._id).trim(), row.confirmCreatedAt);
    }

    /**
     * 4) Build file: ship-date theo confirm batch createdAt của từng order
     * Nếu orderId không tìm thấy trong CONFIRM (hiếm), fallback về ngày tạo UPDATE mới nhất
     */
    let content =
      "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

    let totalOrders = 0;

    for (const [orderId, tracking] of orderMap.entries()) {
      const confirmCreatedAt = confirmDateMap.get(orderId);

      // fallback: nếu không tìm thấy confirm batch, lấy ngày hiện tại (hoặc bạn có thể bỏ qua)
      const shipDateStr = buildShipDateString(confirmCreatedAt || new Date());

      content += [orderId, shipDateStr, carrierCode, tracking, shipMethod].join(
        "\t"
      );

      content += "\n";
      totalOrders++;
    }

    const filename = `update_all_fake_${Date.now()}.txt`;

    return res
      .status(200)
      .set("Content-Type", "text/tab-separated-values; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${filename}"`)
      .send(content);
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
};
