const db = require("../models");
const mongoose = require("mongoose");
const IdeaTask = db.IdeaTask; // export trong models/index.js
const { uploadBufferToWasabi, getSignedUrlForKey } = require("../utils/wasabi");
const multer = require("multer");
const path = require("path");
const {
  addPointsFromTask,
  addPenaltyFromTask,
} = require("../service/pointsService.js");
const TaskType = require("../enumeration/taskType");
const ALLOWED_EXTS = [".psd", ".psb", ".zip"];
const MIME_BY_EXT = {
  ".psd": "image/vnd.adobe.photoshop",
  ".psb": "application/octet-stream", // PSB không có mime chuẩn
  ".zip": "application/zip",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || "").toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      return cb(new Error("Only .psd, .psb, .zip are allowed"));
    }
    cb(null, true);
  },
});

// ===== Helpers =====
const STAT_KEYS = [
  "New",
  "Assigned",
  "In Progress",
  "Uploaded",
  "QC Rejected",
  "QC Passed",
];

const normalizeStatus = (s) => {
  switch (String(s || "").trim()) {
    case "Submitted":
      return "Uploaded";
    case "Approved":
      return "QC Passed";
    case "Rejected":
      return "QC Rejected";
    default:
      return s || "New";
  }
};

const hasRole = (roleOrArr, role) => {
  if (Array.isArray(roleOrArr))
    return roleOrArr.some((r) => new RegExp(`^${role}$`, "i").test(r));
  return new RegExp(`^${role}$`, "i").test(roleOrArr || "");
};

const actor = (req) => ({
  userId: req?.user?.userId || "",
  name: req?.user?.full_name || req?.user?.name || "",
});

const canView = (req, task) => {
  const r = req.user?.role;
  const isAdmin = hasRole(r, "Admin");
  const isDL = hasRole(r, "Design Leader");
  const isDesigner = hasRole(r, "Designer");
  const isCS = hasRole(r, "Customer Service")
  const me = req.user?.userId;

  if (isAdmin || isDL) return true;
  if (task.createdBy?.userId === me) return true;
  if (isDesigner && task.assignedTo?.userId === me) return true;
  if (isCS && task.assignedTo?.userId === me) return true;
  return false;
};

const canEditIdeaBasics = (req, task) => {
  const r = req.user?.role;
  const isAdmin = hasRole(r, "Admin");
  const isDL = hasRole(r, "Design Leader");
  const me = req.user?.userId;
  if (isAdmin || isDL) return true;
  if (task.createdBy?.userId === me) return true;
  return task.status === "New" && task.createdBy?.userId === me;
};

const buildIdeaPsdKey = (ideaId, filename) => {
  const safe = String(filename).replace(/[^\w\-.]+/g, "_");
  const ts = Date.now();
  return `idea_tasks/${ideaId}/${ts}__${safe}`;
};

function buildFilterFromQuery(req) {
  const { status, difficulty, assignee, from, to, search } = req.query;
  const filter = {};

  if (status) filter.status = status;
  if (difficulty) filter.difficulty = difficulty;
  if (assignee) filter["assignedTo"] = new mongoose.Types.ObjectId(assignee);
  if (from && to) {
    filter.createdAt = {
      $gte: new Date(from),
      $lte: new Date(to),
    };
  }

  if (search) filter.$text = { $search: search };
  const r = req.user?.role;
  const isAdmin = hasRole(r, "Admin");
  const isDL = hasRole(r, "Design Leader");
  const isDesigner = hasRole(r, "Designer");
  const me = req.user?.userId;
  const meObjectId = new mongoose.Types.ObjectId(me);
  if (isAdmin || isDL) {
    return filter;
  }

  const orConditions = [];

  if (isDL) {
    orConditions.push(
      { createdBy: meObjectId },
      { "assignedTo._id": meObjectId }
    );
  } else if (isDesigner) {
    orConditions.push({ assignedTo: meObjectId });
  } else {
    orConditions.push({ createdBy: meObjectId });
  }

  if (orConditions.length > 0) {
    filter.$or = orConditions;
  }
  return filter;
}

// =========================
// GET LIST
// =========================
const getAllIdeaTasks = async (req, res) => {
  try {
    const {
      page = 1,
      perPage = 10,
      sort = "createdAt",
      order = "desc",
      select,
    } = req.query;

    const filter = buildFilterFromQuery(req);
    const p = Math.max(1, Number(page));
    const limit = Math.max(1, Math.min(200, Number(perPage)));
    const skip = (p - 1) * limit;
    const [total, data] = await Promise.all([
      IdeaTask.countDocuments(filter),
      IdeaTask.find(filter)
        .sort({ [sort]: /asc/i.test(order) ? 1 : -1 })
        .skip(skip)
        .limit(limit)
        .select(select ? select.replace(/\s+/g, "") : undefined)
        .populate("createdBy", "full_name email role") // chỉ lấy field cần
        .populate("assignedTo", "full_name email role")
        .lean(),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const hasNext = p < totalPages;
    const hasPrev = p > 1;

    res.json({
      message: "OK",
      page: p,
      perPage: limit,
      total,
      totalPages,
      hasNext,
      hasPrev,
      data,
    });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

// =========================
// STATISTICS
// =========================
const getIdeaTaskStatistics = async (req, res) => {
  try {
    let filter = buildFilterFromQuery(req);
    const raw = await IdeaTask.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const result = { all: 0 };
    STAT_KEYS.forEach((k) => {
      result[k] = 0;
    });

    raw.forEach((row) => {
      const norm = normalizeStatus(row._id);
      if (STAT_KEYS.includes(norm)) {
        result[norm] += row.count;
        result.all += row.count;
      }
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

// =========================
// CRUD
// =========================
const getIdeaTaskById = async (req, res) => {
  try {
    const task = await IdeaTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Not found" });
    if (!canView(req, task))
      return res.status(403).json({ message: "Access denied" });
    res.json({ message: "OK", data: task });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};
const createIdeaTask = async (req, res) => {
  try {
    const { title, description, referenceLink, deadline, productType, image } =
      req.body;

    // validate bắt buộc
    if (!title || !description || !productType || !image) {
      return res.status(400).json({
        message: "Missing required fields",
        required: ["title", "description", "productType", "image"],
      });
    }

    const doc = await IdeaTask.create({
      title,
      description,
      referenceLink: referenceLink || "",
      deadline: deadline ? new Date(deadline) : undefined,
      createdBy: req.user.userId, // chỉ lưu ObjectId (đã đổi sang ref User)
      productType,
      image,
      status: "New",
      history: [
        {
          by: req.user.userId,
          action: "created",
          meta: { productType, image },
        },
      ],
    });

    // populate để trả về đầy đủ thông tin user
    await doc.populate("createdBy", "full_name email role");
    await doc.populate("assignedTo", "full_name email role");

    res.json({ message: "Created", data: doc });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

const updateIdeaTask = async (req, res) => {
  try {
    const task = await IdeaTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Not found" });
    if (!canEditIdeaBasics(req, task))
      return res.status(403).json({ message: "Access denied" });

    const { title, description, referenceLink, deadline, productType, image } =
      req.body;

    if (title !== undefined) task.title = title;
    if (description !== undefined) task.description = description;
    if (referenceLink !== undefined) task.referenceLink = referenceLink;
    if (deadline !== undefined)
      task.deadline = deadline ? new Date(deadline) : undefined;

    // mới thêm:
    if (productType !== undefined) task.productType = productType;
    if (image !== undefined) task.image = image;

    task.history.push({
      by: req.user.userId,
      action: "update",
      meta: { productType, image },
    });

    await task.save();

    // populate khi trả về
    await task.populate("createdBy", "full_name email role");
    await task.populate("assignedTo", "full_name email role");

    res.json({ message: "Updated", data: task });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

const deleteIdeaTask = async (req, res) => {
  try {
    const deleted = await IdeaTask.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted", deletedId: req.params.id });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

// =========================
// FLOW ACTIONS
// =========================
const assignIdeaTask = async (req, res) => {
  try {
    const { difficulty, assigneeUserId } = req.body;
    const task = await IdeaTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Not found" });

    if (difficulty !== undefined) task.difficulty = task.difficulty;
    if (assigneeUserId) task.assignedTo = assigneeUserId; // chỉ lưu ObjectId

    task.status = "Assigned";
    task.history.push({
      by: req.user.userId,
      action: "assigned",
      meta: { difficulty: task.difficulty, assignedTo: assigneeUserId },
    });

    await task.save();
    res.json({ message: "Assigned", data: task });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

const startWork = async (req, res) => {
  try {
    const task = await IdeaTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Not found" });

    const me = req.user?.userId || "";
    const r = req.user?.role;
    const isDesigner = hasRole(r, "Designer");
    const isAdmin = hasRole(r, "Admin");
    const isDL = hasRole(r, "Design Leader");

    // so sánh với ref (ObjectId)
    const isAssignee = task.assignedTo?.toString?.() === String(me);
    if (!(isAdmin || isDL || (isDesigner && isAssignee))) {
      return res.status(403).json({ message: "Access denied" });
    }

    task.status = "In Progress";
    task.history.push({ by: req.user.userId, action: "start" }); // <<== dùng ObjectId
    await task.save();
    res.json({ message: "In Progress", data: task });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

const uploadSingle = upload.single("file");

const uploadPsd = async (req, res) => {
  uploadSingle(req, res, async (multerErr) => {
    try {
      if (multerErr) {
        if (multerErr.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ message: "File too large (max 1GB)" });
        }
        return res
          .status(400)
          .json({ message: multerErr.message || "Upload error" });
      }

      const task = await IdeaTask.findById(req.params.id);
      if (!task) return res.status(404).json({ message: "Not found" });

      // RBAC: Admin/DL hoặc Designer được assign
      const me = String(req.user?.userId || "");
      const r = req.user?.role;
      const isDesigner = hasRole(r, "Designer");
      const isAdmin = hasRole(r, "Admin");
      const isDL = hasRole(r, "Design Leader");
      const isAssignee = task.assignedTo?.toString?.() === me;

      if (!(isAdmin || isDL || (isDesigner && isAssignee))) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (!req.file?.buffer) {
        return res.status(400).json({ message: "Thiếu file (field: file)" });
      }

      // Xác định ext & contentType giống listing.controller
      const originalName = req.file.originalname || "design.zip";
      const ext = (path.extname(originalName) || ".zip").toLowerCase();
      const contentType =
        MIME_BY_EXT[ext] || req.file.mimetype || "application/octet-stream";

      // Tạo key theo quy ước của bạn cho Idea Task
      // ví dụ: idea_tasks/<_id>/<timestamp>__<safe_name>
      const key = buildIdeaPsdKey(String(task._id), originalName);

      // ✅ GỌI WRAPPER THEO CÁCH LISTING: { key, contentType } (viết thường)
      const { url } = await uploadBufferToWasabi(req.file.buffer, {
        key,
        contentType,
      });

      // Cập nhật DB
      task.psd = {
        key,
        url,
        uploadedAt: new Date(),
        uploadedBy: req.user.userId, // ref User (ObjectId)
      };
      task.status = "Uploaded";
      task.history.push({
        by: req.user.userId,
        action: "upload",
        meta: {
          key,
          file_name: originalName,
          ext,
          size: req.file.size || null,
        },
      });

      await task.save();

      // populate để trả về đẹp
      await task.populate("createdBy", "full_name email role");
      await task.populate("assignedTo", "full_name email role");

      return res.json({ message: "Uploaded", data: task });
    } catch (error) {
      return res.status(500).json({ error: { message: error.message } });
    }
  });
};

function canApproveOrReject(req, task) {
  const r = req.user?.role;
  const me = req.user?.userId || "";
  const isAdmin = hasRole(r, "Admin");
  const isDL = hasRole(r, "Design Leader");
  const isSeller = hasRole(r, "Seller");
  if (isAdmin || isDL || isSeller) return true;
  if (isSeller && task?.createdBy?.userId === me) return true;
  return false;
}

const approveTask = async (req, res) => {
  try {
    const task = await IdeaTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Not found" });
    if (!canApproveOrReject(req, task))
      return res.status(403).json({ message: "Access denied" });

    task.status = "QC Passed";
    task.history.push({ by: req.user.userId, action: "approve" });
    await task.save();

    await task.populate("createdBy", "full_name email role");
    await task.populate("assignedTo", "full_name email role");

    // === Giữ nguyên: Cộng điểm khi QC Passed ===
    await addPointsFromTask({
      userId: task.assignedTo?._id || task.assignedTo, // hỗ trợ cả ObjectId & populated
      taskId: String(task._id), // idempotent theo task
      type: TaskType.IdeaTask,
      difficulty: task.difficulty || "Easy",
      note: "Idea QC Passed",
    });

    res.json({ message: "QC Passed", data: task });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

const rejectTask = async (req, res) => {
  try {
    const { reason } = req.body;
    const task = await IdeaTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Not found" });
    if (!canApproveOrReject(req, task))
      return res.status(403).json({ message: "Access denied" });

    const prevKey = task.psd?.key || "";
    task.psd = { key: "", url: "", uploadedAt: null, uploadedBy: undefined };

    task.status = "QC Rejected";
    task.history.push({
      by: req.user.userId,
      action: "reject",
      meta: { reason, clearedKey: prevKey },
    });
    await task.save();

    await task.populate("createdBy", "full_name email role");
    await task.populate("assignedTo", "full_name email role");

    // === NEW: Trừ điểm khi QC Rejected (idempotent) ===
    if (task.assignedTo) {
      try {
        const penaltyTaskId = `${task._id}:idea_qc_reject`;
        await addPenaltyFromTask({
          userId: task.assignedTo?._id || task.assignedTo,
          taskId: penaltyTaskId,
          type: TaskType.IdeaTask,
          difficulty: task.difficulty || "Easy",
          note: reason || "Idea QC Rejected",
        });
      } catch (penErr) {
        console.error(
          "[Idea.rejectTask] penalty failed:",
          penErr?.message || penErr
        );
      }
    }

    res.json({ message: "QC Rejected", data: task });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

const addComment = async (req, res) => {
  try {
    const { text } = req.body;
    const task = await IdeaTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Not found" });
    if (!canView(req, task))
      return res.status(403).json({ message: "Access denied" });

    task.comments.push({ by: req.user.userId, text }); // <<==
    task.history.push({ by: req.user.userId, action: "comment" }); // <<==
    await task.save();

    await task.populate("createdBy", "full_name email role");
    await task.populate("assignedTo", "full_name email role");

    res.json({ message: "Commented", data: task });
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
};

const getIdeaPsdSignedUrl = async (req, res) => {
  try {
    const { id } = req.params;
    const expires = Math.max(
      60,
      Math.min(86400, Number(req.query.expires) || 3600)
    );
    const asAttachment = String(req.query.download || "") === "1";

    const task = await IdeaTask.findById(id);
    if (!task) {
      return res.status(404).json({ message: "Task không tồn tại" });
    }

    // Quyền: ai xem được task thì được tải PSD
    if (!canView(req, task)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (!task.psd || !task.psd.key) {
      return res
        .status(404)
        .json({ message: "Task chưa có file PSD / ZIP để tải" });
    }

    const key = task.psd.key;
    const ext = (path.extname(key) || ".zip").toLowerCase();

    // Đặt tên file tải về cho đẹp
    const safeTitle = String(task.title || task._id).replace(/[^\w\-.]+/g, "_");
    const filename = `${safeTitle}${ext}`;

    const url = await getSignedUrlForKey(key, {
      expiresIn: expires,
      asAttachment,
      filename,
    });

    return res.json({
      id: String(task._id),
      key,
      signed_url: url,
      expires_in: expires,
    });
  } catch (error) {
    console.error("Error getIdeaPsdSignedUrl:", error);
    return res.status(500).json({
      message: "Lỗi tạo signed URL cho IdeaTask",
      error: error.message,
    });
  }
};

module.exports = {
  getAllIdeaTasks,
  getIdeaTaskById,
  createIdeaTask,
  updateIdeaTask,
  deleteIdeaTask,
  assignIdeaTask,
  startWork,
  uploadPsd,
  approveTask,
  rejectTask,
  addComment,
  getIdeaTaskStatistics,
  getIdeaPsdSignedUrl,
};
