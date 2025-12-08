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

function parseOrderIdsFromTxt(fileBuffer) {
  const raw = fileBuffer.toString("utf8");

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  const headerLine = lines[0];
  let delimiter = "\t";

  const headers = headerLine
    .split(delimiter)
    .map((h) => h.trim().toLowerCase());
  const orderIdIndex = headers.findIndex(
    (h) => h === "order-id" || h === '"order-id"'
  );

  if (orderIdIndex === -1) {
    throw new Error("Không tìm thấy cột 'order-id' trong file TXT");
  }

  const orderIds = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const cols = line.split(delimiter);
    const val = (cols[orderIdIndex] || "").trim();
    if (!val) continue;

    orderIds.push(val);
  }

  return Array.from(new Set(orderIds));
}

/**
 * POST /api/shipping-batches
 * multipart/form-data:
 *  - file: TXT (mỗi dòng 1 orderId)
 *  - machineId: string
 *  - label: string
 *  - confirmShipDate: (optional) yyyy-mm-dd / ISO string
 */
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

    // 1) Lấy danh sách orderId từ file
    const orderIds = parseOrderIdsFromTxt(file.buffer);
    if (!orderIds.length) {
      return res.status(400).json({ message: "No orderId found in file" });
    }

    const completed = [];
    const tracking_fakes = [];

    // 2) Với mỗi orderId: lấy tracking hoặc gen fake
    for (const orderId of orderIds) {
      const realTracking = await getRealTrackingForOrder(
        orderId,
        machineId,
        label
      );

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

    // 3) Stats
    const stats = {
      totalOrders: completed.length,
      totalFake: completed.filter((r) => r.isFake).length,
      totalReal: completed.filter((r) => !r.isFake).length,
    };

    // 4) Tạo record batch
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

    // 5) Build nội dung file confirm ship từ "completed"
    const rows = completed.map((r) => ({
      orderId: r.orderId,
      tracking: r.tracking,
    }));
    const confirmFileContent = buildPlainTextFile(rows);

    return res.status(201).json({
      batchId: batch._id,
      machineId: batch.machineId,
      label: batch.label,
      status: batch.status,
      fileName: batch.fileName,
      stats: batch.stats,
      confirmFileContent, // FE / extension dùng string này để tải file
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
    const { machineId, label } = req.body;

    const original = await ShippingBatch.findById(batchId);
    if (!original) {
      return res.status(404).json({ message: "Original batch not found" });
    }

    // Optional: check đúng máy & acc
    if (machineId && original.machineId !== machineId) {
      return res
        .status(400)
        .json({ message: "machineId mismatch with original batch" });
    }
    if (label && original.label !== label) {
      return res
        .status(400)
        .json({ message: "label mismatch with original batch" });
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

module.exports = {
  createBatchFromFile,
  listShippingBatches,
  createUpdateBatchFromSystem,
};
