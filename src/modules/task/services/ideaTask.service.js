const IdeaTask = require("../models/ideaTask.model");
const mongoose = require("mongoose");
const { uploadBufferToWasabi, getSignedUrlForKey } = require("../../../utils/wasabi");
const path = require("path");
const { addPointsFromTask, addPenaltyFromTask } = require("../../system/services/points.service");
const TaskType = require("../constants/taskType");

const ALLOWED_EXTS = [".psd", ".psb", ".zip"];
const MIME_BY_EXT = {
    ".psd": "image/vnd.adobe.photoshop",
    ".psb": "application/octet-stream",
    ".zip": "application/zip",
};

const STAT_KEYS = ["New", "Assigned", "In Progress", "Uploaded", "QC Rejected", "QC Passed"];

const normalizeStatus = (s) => {
    switch (String(s || "").trim()) {
        case "Submitted": return "Uploaded";
        case "Approved": return "QC Passed";
        case "Rejected": return "QC Rejected";
        default: return s || "New";
    }
};

const hasRole = (roleOrArr, role) => {
    if (Array.isArray(roleOrArr)) return roleOrArr.some((r) => new RegExp(`^${role}$`, "i").test(r));
    return new RegExp(`^${role}$`, "i").test(roleOrArr || "");
};

const canView = (user, task) => {
    const r = user?.role;
    const isAdmin = hasRole(r, "Admin");
    const isDL = hasRole(r, "Design Leader");
    const isDesigner = hasRole(r, "Designer");
    const isCS = hasRole(r, "Customer Service");
    const me = user?.userId;

    if (isAdmin || isDL) return true;
    if (task.createdBy?.userId === me || task.createdBy === me) return true;
    if (isDesigner && (task.assignedTo?.userId === me || task.assignedTo?.toString() === me)) return true;
    if (isCS && (task.assignedTo?.userId === me || task.assignedTo?.toString() === me)) return true;
    return false;
};

const canEditIdeaBasics = (user, task) => {
    const r = user?.role;
    const isAdmin = hasRole(r, "Admin");
    const isDL = hasRole(r, "Design Leader");
    const me = user?.userId;
    if (isAdmin || isDL) return true;
    return task.status === "New" && (task.createdBy?.userId === me || task.createdBy?.toString() === me);
};

const buildIdeaPsdKey = (ideaId, filename) => {
    const safe = String(filename).replace(/[^\w\-.]+/g, "_");
    const ts = Date.now();
    return `idea_tasks/${ideaId}/${ts}__${safe}`;
};

class IdeaTaskService {
    buildFilterFromQuery(query, user) {
        const { status, difficulty, assignee, from, to, search } = query;
        const filter = {};

        if (status) filter.status = status;
        if (difficulty) filter.difficulty = difficulty;
        if (assignee) filter["assignedTo"] = new mongoose.Types.ObjectId(assignee);
        if (from && to) {
            filter.createdAt = { $gte: new Date(from), $lte: new Date(to) };
        }

        if (search) filter.$text = { $search: search };
        const r = user?.role;
        const isAdmin = hasRole(r, "Admin");
        const isDL = hasRole(r, "Design Leader");
        const isDesigner = hasRole(r, "Designer");
        const isCS = hasRole(r, "Customer Service");

        const me = user?.userId;
        const meObjectId = new mongoose.Types.ObjectId(me);
        if (isAdmin || isDL) return filter;

        const orConditions = [];
        if (isDL) {
            orConditions.push({ createdBy: meObjectId }, { "assignedTo._id": meObjectId });
        } else if (isDesigner || isCS) {
            orConditions.push({ assignedTo: meObjectId });
        } else {
            orConditions.push({ createdBy: meObjectId });
        }

        if (orConditions.length > 0) filter.$or = orConditions;
        return filter;
    }

    async getAllIdeaTasks(query, user) {
        const { page = 1, perPage = 10, sort = "createdAt", order = "desc", select } = query;
        const filter = this.buildFilterFromQuery(query, user);
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
                .populate("createdBy", "full_name email role")
                .populate("assignedTo", "full_name email role")
                .lean(),
        ]);

        const totalPages = Math.max(1, Math.ceil(total / limit));
        return {
            page: p,
            perPage: limit,
            total,
            totalPages,
            hasNext: p < totalPages,
            hasPrev: p > 1,
            data,
        };
    }

    async getIdeaTaskStatistics(query, user) {
        const filter = this.buildFilterFromQuery(query, user);
        const raw = await IdeaTask.aggregate([{ $match: filter }, { $group: { _id: "$status", count: { $sum: 1 } } }]);
        const result = { all: 0 };
        STAT_KEYS.forEach((k) => { result[k] = 0; });
        raw.forEach((row) => {
            const norm = normalizeStatus(row._id);
            if (STAT_KEYS.includes(norm)) {
                result[norm] += row.count;
                result.all += row.count;
            }
        });
        return result;
    }

    async getIdeaTaskById(id, user) {
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");
        if (!canView(user, task)) throw new Error("Access denied");
        return task;
    }

    async createIdeaTask(data, user) {
        const { title, description, referenceLink, deadline, productType, image } = data;
        if (!title || !description || !productType || !image) {
            throw new Error("Missing required fields: title, description, productType, image");
        }

        const doc = await IdeaTask.create({
            title,
            description,
            referenceLink: referenceLink || "",
            deadline: deadline ? new Date(deadline) : undefined,
            createdBy: user.userId,
            productType,
            image,
            status: "New",
            history: [{ by: user.userId, action: "created", meta: { productType, image } }],
        });

        await doc.populate("createdBy", "full_name email role");
        await doc.populate("assignedTo", "full_name email role");
        return doc;
    }

    async updateIdeaTask(id, data, user) {
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");
        if (!canEditIdeaBasics(user, task)) throw new Error("Access denied");

        const { title, description, referenceLink, deadline, productType, image } = data;
        if (title !== undefined) task.title = title;
        if (description !== undefined) task.description = description;
        if (referenceLink !== undefined) task.referenceLink = referenceLink;
        if (deadline !== undefined) task.deadline = deadline ? new Date(deadline) : undefined;
        if (productType !== undefined) task.productType = productType;
        if (image !== undefined) task.image = image;

        task.history.push({ by: user.userId, action: "update", meta: { productType, image } });
        await task.save();

        await task.populate("createdBy", "full_name email role");
        await task.populate("assignedTo", "full_name email role");
        return task;
    }

    async deleteIdeaTask(id) {
        const deleted = await IdeaTask.findByIdAndDelete(id);
        if (!deleted) throw new Error("Not found");
        return { message: "Deleted", deletedId: id };
    }

    async assignIdeaTask(id, data, user) {
        const { difficulty, assigneeUserId } = data;
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");

        if (difficulty !== undefined) task.difficulty = difficulty;
        if (assigneeUserId) task.assignedTo = assigneeUserId;

        task.status = "Assigned";
        task.history.push({
            by: user.userId,
            action: "assigned",
            meta: { difficulty: task.difficulty, assignedTo: assigneeUserId },
        });

        await task.save();
        return task;
    }

    async startWork(id, user) {
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");

        const me = user?.userId || "";
        const isAssignee = task.assignedTo?.toString() === String(me);
        const r = user?.role;
        const isAdmin = hasRole(r, "Admin");
        const isDL = hasRole(r, "Design Leader");
        const isDesigner = hasRole(r, "Designer");

        if (!(isAdmin || isDL || (isDesigner && isAssignee))) throw new Error("Access denied");

        task.status = "In Progress";
        task.history.push({ by: user.userId, action: "start" });
        await task.save();
        return task;
    }

    async uploadPsd(id, file, user) {
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");

        const me = String(user?.userId || "");
        const isAssignee = task.assignedTo?.toString() === me;
        const r = user?.role;
        const isAdmin = hasRole(r, "Admin");
        const isDL = hasRole(r, "Design Leader");
        const isDesigner = hasRole(r, "Designer");

        if (!(isAdmin || isDL || (isDesigner && isAssignee))) throw new Error("Access denied");
        if (!file?.buffer) throw new Error("Thiếu file");

        const originalName = file.originalname || "design.zip";
        const ext = (path.extname(originalName) || ".zip").toLowerCase();
        const contentType = MIME_BY_EXT[ext] || file.mimetype || "application/octet-stream";
        const key = buildIdeaPsdKey(String(task._id), originalName);

        const { url } = await uploadBufferToWasabi(file.buffer, { key, contentType });

        task.psd = { key, url, uploadedAt: new Date(), uploadedBy: user.userId };
        task.status = "Uploaded";
        task.history.push({
            by: user.userId,
            action: "upload",
            meta: { key, file_name: originalName, ext, size: file.size || null },
        });

        await task.save();
        await task.populate("createdBy", "full_name email role");
        await task.populate("assignedTo", "full_name email role");
        return task;
    }

    async approveTask(id, user) {
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");

        const r = user?.role;
        const isAdmin = hasRole(r, "Admin");
        const isDL = hasRole(r, "Design Leader");
        const isSeller = hasRole(r, "Seller");
        const me = user?.userId || "";

        let canApprove = isAdmin || isDL;
        if (isSeller && task.createdBy?.toString() === me) canApprove = true;
        if (!canApprove) throw new Error("Access denied");

        task.status = "QC Passed";
        task.history.push({ by: user.userId, action: "approve" });
        await task.save();

        await addPointsFromTask({
            userId: task.assignedTo?._id || task.assignedTo,
            taskId: String(task._id),
            type: TaskType.IdeaTask,
            difficulty: task.difficulty || "Easy",
            note: "Idea QC Passed",
        });

        await task.populate("createdBy", "full_name email role");
        await task.populate("assignedTo", "full_name email role");
        return task;
    }

    async rejectTask(id, reason, user) {
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");

        const r = user?.role;
        const isAdmin = hasRole(r, "Admin");
        const isDL = hasRole(r, "Design Leader");
        const isSeller = hasRole(r, "Seller");
        const me = user?.userId || "";

        let canReject = isAdmin || isDL;
        if (isSeller && task.createdBy?.toString() === me) canReject = true;
        if (!canReject) throw new Error("Access denied");

        const prevKey = task.psd?.key || "";
        task.psd = { key: "", url: "", uploadedAt: null, uploadedBy: undefined };
        task.status = "QC Rejected";
        task.history.push({ by: user.userId, action: "reject", meta: { reason, clearedKey: prevKey } });
        await task.save();

        if (task.assignedTo) {
            try {
                await addPenaltyFromTask({
                    userId: task.assignedTo?._id || task.assignedTo,
                    taskId: `${task._id}:idea_qc_reject`,
                    type: TaskType.IdeaTask,
                    difficulty: task.difficulty || "Easy",
                    note: reason || "Idea QC Rejected",
                });
            } catch (penErr) {
                console.error("[Idea.rejectTask] penalty failed:", penErr.message);
            }
        }

        await task.populate("createdBy", "full_name email role");
        await task.populate("assignedTo", "full_name email role");
        return task;
    }

    async addComment(id, text, user) {
        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Not found");
        if (!canView(user, task)) throw new Error("Access denied");

        task.comments.push({ by: user.userId, text });
        task.history.push({ by: user.userId, action: "comment" });
        await task.save();

        await task.populate("createdBy", "full_name email role");
        await task.populate("assignedTo", "full_name email role");
        return task;
    }

    async getIdeaPsdSignedUrl(id, query, user) {
        const expires = Math.max(60, Math.min(86400, Number(query.expires) || 3600));
        const asAttachment = String(query.download || "") === "1";

        const task = await IdeaTask.findById(id);
        if (!task) throw new Error("Task không tồn tại");
        if (!canView(user, task)) throw new Error("Access denied");
        if (!task.psd || !task.psd.key) throw new Error("Task chưa có file PSD / ZIP để tải");

        const key = task.psd.key;
        const ext = (path.extname(key) || ".zip").toLowerCase();
        const safeTitle = String(task.title || task._id).replace(/[^\w\-.]+/g, "_");
        const filename = `${safeTitle}${ext}`;

        const url = await getSignedUrlForKey(key, { expiresIn: expires, asAttachment, filename });
        return { id: String(task._id), key, signed_url: url, expires_in: expires };
    }
}

module.exports = new IdeaTaskService();

