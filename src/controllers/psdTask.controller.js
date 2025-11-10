// controllers/psdTask.controller.js
const db = require("../models");
const PsdTask = db.PsdTask;
const Listing = db.listing;
const psdTaskService = require("../service/psdTask/psdTask.js");
const { uploadBufferToWasabi } = require("../utils/wasabi.js");
const mongoose = require("mongoose");
const { addPointsFromTask, addPenaltyFromTask } = require('../service/pointsService.js');
const TaskType = require('../enumeration/taskType')
// helper: chấp nhận role là string hoặc array
function hasRole(userRole, target) {
  if (!userRole) return false;
  if (Array.isArray(userRole)) {
    return userRole.some(
      (r) => String(r).toLowerCase() === String(target).toLowerCase()
    );
  }
  return String(userRole).toLowerCase() === String(target).toLowerCase();
}

const getTasks = async (req, res) => {
  try {
    const {
      status,
      seller,
      designer,
      page = 1,
      perPage = 10,
      from,
      to,
      search, // <<<< NEW
    } = req.query;

    const filter = {};

    // ===== client filters =====
    if (status) filter.status = status; // sẽ bị RBAC refine cho Designer
    if (seller) filter.seller = seller;
    if (designer) filter.designer = designer;

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    // ===== ASIN search (NEW) =====
    if (search && String(search).trim()) {
      const asinTokens = String(search)
        .split(/[,\s]+/) // cho phép "B0XXX,B0YYY" hoặc "B0XXX B0YYY"
        .map((s) => s.trim())
        .filter(Boolean);

      // Tạo regex list (khớp chính xác, không phân biệt hoa thường)
      const asinRegexes = asinTokens.map(
        (tok) => new RegExp(`^${escapeRegex(tok)}$`, "i")
      );

      // 1) Tìm các listing có asin khớp
      const listings = await Listing.find(
        { asin: { $in: asinRegexes } },
        { _id: 1 }
      ).lean();

      const listingIds = listings.map((l) => l._id);

      // 2) Ghép điều kiện vào filter:
      filter.$or = [
        { listing: { $in: listingIds } },
        { asin: { $in: asinRegexes } },
      ];

      if (listingIds.length === 0) {
        // có thể return rỗng sớm nếu muốn, nhưng giữ nguyên logic cũ
      }
    }

    // ===== RBAC gating =====
    const userId = req.user?.userId;
    const role = req.user?.role;

    const isAdmin = hasRole(role, "Admin");
    const isDesignLeader = hasRole(role, "Design Leader");
    const isSeller = hasRole(role, "Seller");
    const isDesigner = hasRole(role, "Designer");

    if (isSeller && !isAdmin && !isDesignLeader) {
      filter.seller = userId;
    }

    if (isDesigner && !isAdmin && !isDesignLeader) {
      filter.designer = userId;

      const excludeForDesigner = ["New", "Requested"];
      if (filter.status) {
        if (excludeForDesigner.includes(filter.status)) {
          return res.json({ total: 0, tasks: [] });
        }
      } else {
        filter.status = { $nin: excludeForDesigner };
      }
    }

    // ===== Query (CHỈ THÊM SORT) =====
    const [tasks, total] = await Promise.all([
      PsdTask.find(filter)
        .populate("seller designer leader listing")
        .sort({ createdAt: -1 }) // <<<< NEW: sắp xếp mới nhất lên đầu
        .skip((page - 1) * Number(perPage))
        .limit(Number(perPage)),
      PsdTask.countDocuments(filter),
    ]);

    return res.json({ total, tasks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ===== Helper: escape regex special chars =====
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const toObjId = (v) =>
  v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : v;

const getTaskStatistics = async (req, res) => {
  try {
    const { seller, designer, from, to, scoped, search } = req.query;

    // ===== RBAC =====
    const userId = req.user?.userId;
    const role = req.user?.role;

    const isAdmin = hasRole(role, "Admin");
    const isDesignLeader = hasRole(role, "Design Leader");
    const isSeller = hasRole(role, "Seller");
    const isDesigner = hasRole(role, "Designer");

    const ALL_STATUSES = [
      "New",
      "Requested",
      "Assigned",
      "In Progress",
      "Uploaded",
      "QC Rejected",
      "QC Passed",
    ];
    const ROLE_STATUSES =
      isDesigner && !isAdmin && !isDesignLeader
        ? ["Assigned", "In Progress", "Uploaded", "QC Rejected", "QC Passed"] // hide New/Requested
        : ALL_STATUSES;

    // ===== Build match =====
    const match = { status: { $in: ROLE_STATUSES } };

    // time range
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) match.createdAt.$lte = new Date(to);
    }

    // search theo ASIN (NEW)
    if (search && String(search).trim()) {
      const asinTokens = String(search)
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const asinRegexes = asinTokens.map(
        (tok) => new RegExp(`^${escapeRegex(tok)}$`, "i")
      );

      const listings = await Listing.find(
        { asin: { $in: asinRegexes } },
        { _id: 1 }
      ).lean();

      const listingIds = listings.map((l) => l._id);

      // nếu task có field asin trực tiếp → dùng $or
      match.$or = [
        { listing: { $in: listingIds } },
        { asin: { $in: asinRegexes } },
      ];

      // Nếu bạn chắc chắn task không có field asin → có thể chỉ cần:
      // match.listing = { $in: listingIds };
      // và nếu listingIds.length === 0 thì trả rỗng luôn
    }

    // RBAC scope
    if (isDesigner && !isAdmin && !isDesignLeader) {
      match.designer = toObjId(userId);
    } else if (isSeller && !isAdmin && !isDesignLeader) {
      match.seller = toObjId(userId);
    } else {
      if (seller) match.seller = toObjId(seller);
      if (designer) match.designer = toObjId(designer);
    }

    // optional: đếm theo đúng 1 status khi thật sự cần
    if ((scoped === "1" || scoped === "true") && req.query.status) {
      const st = String(req.query.status).trim();
      if (!ROLE_STATUSES.includes(st)) {
        return res.status(400).json({ error: `Invalid status: ${st}` });
      }
      match.status = st;
    }

    // ===== Aggregate =====
    const agg = await PsdTask.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    // map đủ key theo ROLE_STATUSES
    const counts = ROLE_STATUSES.reduce((acc, st) => {
      acc[st] = 0;
      return acc;
    }, {});
    for (const r of agg) counts[r._id] = r.count;

    const all = Object.values(counts).reduce((a, b) => a + b, 0);

    return res.json({ all, ...counts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

// ===== Helper =====
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function requestPSD(req, res) {
  try {
    const { taskId, note } = req.body;
    const task = await PsdTask.findById(taskId);
    if (!task) return res.status(404).json({ message: "Task not found" });

    if (task.status !== "New")
      return res.status(409).json({ message: "Only 'New' can be requested" });

    task.history.push({
      at: new Date(),
      by: req.user.userId,
      action: "Seller Request",
      from: "New",
      to: "Requested",
      note: note || "",
    });

    task.status = "Requested";
    task.note = note || "";

    await task.save();

    res.json(task);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}


// POST assign (leader)
const assignDesigner = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { designer, priority, difficulty, dueAt } = req.body;

    const task = await psdTaskService.changeStatus(
      taskId,
      "Assigned",
      req.user.userId,
      "Assign designer",
      null,
      { designer, priority, difficulty, dueAt }
    );
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST start (designer)
const startTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await psdTaskService.changeStatus(
      taskId,
      "In Progress",
      req.user.userId,
      "Start doing"
    );
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

function buildDesignKeyByExt(asin, ext) {
  ext = (ext || ".psd").toLowerCase();
  // Quy ước: psd/<ASIN>/<ASIN><ext>
  return `psd/${asin}/${asin}${ext}`;
}
const MIME_BY_EXT = {
  ".zip": "application/zip",
};

// POST upload file
const uploadPSD = async (req, res) => {
  try {
    const { taskId } = req.params;
    const asin = req.body.asin;
    const task = await psdTaskService.changeStatus(
      taskId,
      "Uploaded",
      req.user.userId,
      "Upload file"
    );
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
      task: task,
    });
  } catch (err) {
    console.error("Error updating design file:", err);
    return res
      .status(500)
      .json({ message: "Error updating design file", error: err.message });
  }
};

// POST QC
const qcPSD = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { result, note } = req.body;
    const userId = req.user.userId;
    const status = result === "pass" ? "QC Passed" : "QC Rejected";

    const task = await psdTaskService.changeStatus(
      taskId,
      status,
      userId,
      "qc",
      note
    );

    if (status === "QC Rejected") {
      // Xoá toàn bộ field `psd` khỏi listing
      await Listing.updateOne({ _id: task.listing }, { $unset: { psd: "" } });

      // === NEW: trừ điểm Designer theo difficulty của task (idempotent) ===
      if (task?.designer) {
        const penaltyTaskId = `${task._id}:psd_qc_reject`;
        const difficulty = task.difficulty || 'Easy';
        try {
          await addPenaltyFromTask({
            userId: task.designer,
            taskId: penaltyTaskId,
            type: TaskType.PSDTask,
            difficulty,
            note: note || 'PSD QC Rejected'
          });
        } catch (penErr) {
          console.error('[qcPSD] penalty failed:', penErr?.message || penErr);
        }
      }
    } else {
      // === QC Passed: Cộng điểm ===
      const designerId = task.designer;
      const difficulty = task.difficulty || "Easy";
      const listing = await Listing.findOne({ _id: task.listing })
        .select('asin')
        .lean();
      if (!listing) {
        console.warn(`[qcPSD] listing not found for task ${taskId}`);
      }
      await addPointsFromTask({
        userId: designerId,
        taskId: listing?.asin || task._id, // fallback để không lỗi nếu thiếu asin
        type: TaskType.PSDTask,
        difficulty: difficulty,
        note: note
      });
    }

    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deletePsdTask = async (req, res) => {
  try {
    const { taskId } = req.params;

    if (!mongoose.isValidObjectId(taskId)) {
      return res.status(400).json({ message: "Invalid taskId" });
    }

    const role = req.user?.role;
    const userId = req.user?.userId;
    const isAdmin = hasRole(role, "Admin");
    const isDesignLeader = hasRole(role, "Design Leader");

    // Chỉ Admin & Design Leader được xóa
    if (!isAdmin && !isDesignLeader) {
      return res.status(403).json({ message: "Access denied" });
    }

    const task = await PsdTask.findById(taskId).lean();
    if (!task) return res.status(404).json({ message: "Task not found" });

    // Chặn xóa task đã QC Passed (tránh lệch điểm thưởng/kỷ luật)
    if (task.status === "QC Passed") {
      return res.status(409).json({
        message:
          "Cannot delete a task that has already QC Passed. Please revert/adjust points manually first.",
      });
    }

    // Nếu bạn muốn "soft delete" thay vì xóa hẳn DB, dùng update sau:
    // await PsdTask.updateOne(
    //   { _id: taskId },
    //   { $set: { deleted: true, deletedAt: new Date(), deletedBy: userId } }
    // );
    // return res.json({ ok: true, softDeleted: true });

    // Hard delete
    await PsdTask.deleteOne({ _id: taskId });

    return res.json({ ok: true, message: "Task deleted" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = {
  getTasks,
  requestPSD,
  assignDesigner,
  startTask,
  uploadPSD,
  qcPSD,
  getTaskStatistics,
  deletePsdTask
};
