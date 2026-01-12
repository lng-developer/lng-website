// controllers/trello/issue.controller.js
const multer = require("multer");
const db = require("../models");
const Issue = db.Issue
const Category = db.Category
const Notification = db.Notification
const { toObjectId, getUserId, assertProjectMember, assertCategoryInProject, reindexOrder } = require("../helper/toDoList.helper.js");
const mongoose = require('mongoose');
const User = db.user;
const cloudinary = require("../utils/cloudinary");
const upload = multer({ storage: multer.memoryStorage() });

function uploadStreamToCloudinary(buffer, opts = {}) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { resource_type: "image", overwrite: true, ...opts },
            (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(buffer);
    });
}
/**
 * Create card in a category
 */
async function createIssue(req, res) {
    const session = await mongoose.startSession();
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;

        const {
            categoryId,
            title,
            description = "",
            assigneeIds = [],
            priority = "medium",
            startAt = null,
            dueAt = null,
        } = req.body || {};

        if (!categoryId) return res.status(400).json({ message: "Missing categoryId" });
        if (!title || !String(title).trim()) return res.status(400).json({ message: "Missing title" });

        if (startAt && dueAt && new Date(startAt) > new Date(dueAt)) {
            return res.status(400).json({ message: "startAt must be before dueAt" });
        }

        await assertProjectMember({ projectId, userId });
        await assertCategoryInProject({ categoryId, projectId });

        session.startTransaction();

        const last = await Issue.findOne({
            projectId: toObjectId(projectId),
            categoryId: toObjectId(categoryId),
            archived: false,
        })
            .sort({ order: -1 })
            .session(session);

        const nextOrder = (last?.order ?? 0) + 1000;

        // ===== NEW: parse assigneeIds when multipart/form-data =====
        let parsedAssigneeIds = assigneeIds;
        if (typeof assigneeIds === "string") {
            try {
                const json = JSON.parse(assigneeIds);
                parsedAssigneeIds = Array.isArray(json) ? json : [];
            } catch {
                parsedAssigneeIds = String(assigneeIds)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }
        // ==========================================================

        // ===== NEW: Upload issue images to Cloudinary =====
        const files = req.files || []; // field name: "files"
        const attachments = [];
        const uploadedPublicIds = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            // public_id theo format dễ quản trị (overwrite được)
            // ví dụ: issues/<projectId>/<categoryId>/<timestamp>-<i>
            const public_id = `issues/${projectId}/${categoryId}/${Date.now()}-${i}`;

            const up = await uploadStreamToCloudinary(file.buffer, { public_id });

            uploadedPublicIds.push(up.public_id);

            attachments.push({
                name: file.originalname || "",
                url: up.secure_url,
                mime: file.mimetype || "",
                size: file.size || 0,
                public_id: up.public_id || public_id,
            });
        }
        // ================================================

        const issue = await Issue.create(
            [
                {
                    projectId: toObjectId(projectId),
                    categoryId: toObjectId(categoryId),
                    title: String(title).trim(),
                    description: String(description || ""),
                    assigneeIds: (Array.isArray(parsedAssigneeIds) ? parsedAssigneeIds : []).map(toObjectId),
                    priority,

                    startAt: startAt ? new Date(startAt) : null,
                    dueAt: dueAt ? new Date(dueAt) : null,

                    order: nextOrder,

                    // NEW
                    attachments,

                    activity: [
                        {
                            type: "created",
                            userId: toObjectId(userId),
                            meta: { categoryId: String(categoryId), attachmentsCount: attachments.length },
                        },
                    ],
                },
            ],
            { session }
        );

        // Notify assignees
        const assignees = (Array.isArray(parsedAssigneeIds) ? parsedAssigneeIds : []).map(String);
        if (assignees.length) {
            const notis = assignees.map((aid) => ({
                userId: toObjectId(aid),
                projectId: toObjectId(projectId),
                issueId: issue[0]._id,
                type: "issue_assigned",
                title: "You were assigned a task",
                message: issue[0].title,
                meta: { issueId: String(issue[0]._id) },
            }));
            await Notification.insertMany(notis, { session });
        }

        await session.commitTransaction();
        return res.json({ data: issue[0] });
    } catch (e) {
        await session.abortTransaction();

        // OPTIONAL (khuyến nghị): nếu DB fail sau khi upload, dọn Cloudinary (best-effort)
        // yêu cầu: bạn phải có `cloudinary` instance trong scope
        // try { await Promise.all(uploadedPublicIds.map(pid => cloudinary.uploader.destroy(pid))); } catch {}

        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    } finally {
        session.endSession();
    }
}



/**
 * Board view: list categories + issues grouped
 */
async function getBoard(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const { includeArchived = "false" } = req.query || {};

        await assertProjectMember({ projectId, userId });

        const pid = toObjectId(projectId);
        const catQuery = { projectId: pid, archived: false };
        const issueQuery = { projectId: pid, archived: false };

        if (String(includeArchived) === "true") {
            catQuery.archived = { $in: [false, true] };
            issueQuery.archived = { $in: [false, true] };
        }

        const categories = await Category.find(catQuery)
            .sort({ order: 1, createdAt: 1 })
            .lean();

        const issues = await Issue.find(issueQuery)
            .sort({ categoryId: 1, order: 1, updatedAt: -1 })
            .lean();

        // ===================== collect userIds (assignees + activity) =====================
        const userIdSet = new Set();

        for (const it of issues) {
            // assigneeIds
            if (Array.isArray(it.assigneeIds)) {
                for (const id of it.assigneeIds) userIdSet.add(String(id));
            }

            // activity.userId
            if (Array.isArray(it.activity)) {
                for (const a of it.activity) {
                    if (a?.userId) userIdSet.add(String(a.userId));
                }
            }
        }

        const userIds = Array.from(userIdSet).map(toObjectId);

        // query users once
        const users = userIds.length
            ? await User.find({ _id: { $in: userIds } })
                .select({ full_name: 1 }) // đổi theo schema của bạn nếu khác
                .lean()
            : [];

        const userMap = new Map(users.map(u => [String(u._id), u]));

        // ===================== attach assignees + activity user =====================
        for (const it of issues) {
            // assignees
            const ids = Array.isArray(it.assigneeIds) ? it.assigneeIds : [];
            it.assignees = ids.map(id => {
                const u = userMap.get(String(id));
                return u ? { _id: u._id, full_name: u.full_name } : { _id: id, full_name: null };
            });

            // activity user
            if (Array.isArray(it.activity)) {
                it.activity = it.activity.map(a => {
                    const u = a?.userId ? userMap.get(String(a.userId)) : null;
                    return {
                        ...a,
                        user: u ? { _id: u._id, full_name: u.full_name } : { _id: a?.userId, full_name: null },
                    };
                });
            }
        }
        // ===================== end manual populate =====================

        const map = new Map(categories.map(c => [String(c._id), { ...c, issues: [] }]));
        for (const it of issues) {
            const key = String(it.categoryId);
            if (!map.has(key)) continue;
            map.get(key).issues.push(it);
        }

        return res.json({ data: Array.from(map.values()) });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}



/**
 * Update issue fields (title/desc/status/priority/dueAt/assignees)
 */
async function updateIssue(req, res) {
  const session = await mongoose.startSession();
  try {
    const userId = getUserId(req);
    const { projectId, issueId } = req.params;
    const { title, description, status, priority, dueAt, startAt, assigneeIds } = req.body || {};

    await assertProjectMember({ projectId, userId });

    session.startTransaction();

    const issue = await Issue.findOne({
      _id: toObjectId(issueId),
      projectId: toObjectId(projectId),
    }).session(session);

    if (!issue) return res.status(404).json({ message: "Issue not found" });

    const update = {};
    if (typeof title === "string") update.title = String(title).trim();
    if (typeof description === "string") update.description = String(description);
    if (typeof status === "string") update.status = status;
    if (typeof priority === "string") update.priority = priority;

    // dueAt
    if (dueAt === null) update.dueAt = null;
    if (typeof dueAt === "string" || dueAt instanceof Date) update.dueAt = new Date(dueAt);

    // startAt (NEW)
    if (startAt === null) update.startAt = null;
    if (typeof startAt === "string" || startAt instanceof Date) update.startAt = new Date(startAt);

    if (Array.isArray(assigneeIds)) update.assigneeIds = assigneeIds.map(toObjectId);

    // activity log
    issue.activity = issue.activity || [];
    issue.activity.push({
      type: "updated",
      userId: toObjectId(userId),
      meta: { fields: Object.keys(update) },
    });

    Object.assign(issue, update);
    await issue.save({ session });

    // notify new assignees if assigneeIds provided
    if (Array.isArray(assigneeIds) && assigneeIds.length) {
      const notis = assigneeIds.map((aid) => ({
        userId: toObjectId(aid),
        projectId: toObjectId(projectId),
        issueId: issue._id,
        type: "issue_assigned",
        title: "You were assigned a task",
        message: issue.title,
        meta: { issueId: String(issue._id) },
      }));
      await Notification.insertMany(notis, { session });
    }

    await session.commitTransaction();
    return res.json({ data: issue.toObject() });
  } catch (e) {
    await session.abortTransaction();
    return res.status(e.status || 500).json({ message: e.message || "Server error" });
  } finally {
    session.endSession();
  }
}


/**
 * Add comment
 */
async function addComment(req, res) {
    const session = await mongoose.startSession();
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;
        const { content, attachments = [] } = req.body || {};
        if (!content || !String(content).trim()) return res.status(400).json({ message: "Missing content" });

        await assertProjectMember({ projectId, userId });

        session.startTransaction();

        const issue = await Issue.findOne({ _id: toObjectId(issueId), projectId: toObjectId(projectId) }).session(session);
        if (!issue) return res.status(404).json({ message: "Issue not found" });

        issue.comments = issue.comments || [];
        issue.comments.push({
            userId: toObjectId(userId),
            content: String(content),
            attachments: Array.isArray(attachments) ? attachments : [],
        });

        issue.activity = issue.activity || [];
        issue.activity.push({ type: "commented", userId: toObjectId(userId), meta: {} });

        await issue.save({ session });

        // notify assignees
        const assignees = (issue.assigneeIds || []).map((x) => String(x)).filter(Boolean);
        if (assignees.length) {
            const notis = assignees.map((aid) => ({
                userId: toObjectId(aid),
                projectId: toObjectId(projectId),
                issueId: issue._id,
                type: "issue_comment",
                title: "New comment",
                message: issue.title,
                meta: { issueId: String(issue._id) },
            }));
            await Notification.insertMany(notis, { session });
        }

        await session.commitTransaction();
        return res.json({ data: issue.toObject() });
    } catch (e) {
        await session.abortTransaction();
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    } finally {
        session.endSession();
    }
}

/**
 * Move issue (drag/drop)
 * body: { toCategoryId, toIndex }
 * - toIndex is zero-based index in destination column
 * Strategy: shift orders by reindexing destination column after inserting at desired position
 */
async function moveIssue(req, res) {
    const session = await mongoose.startSession();
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;
        const { toCategoryId, toIndex = 0 } = req.body || {};

        if (!toCategoryId) return res.status(400).json({ message: "Missing toCategoryId" });

        await assertProjectMember({ projectId, userId });
        await assertCategoryInProject({ categoryId: toCategoryId, projectId });

        session.startTransaction();

        const pid = toObjectId(projectId);
        const issue = await Issue.findOne({ _id: toObjectId(issueId), projectId: pid }).session(session);
        if (!issue) return res.status(404).json({ message: "Issue not found" });

        const fromCategoryId = String(issue.categoryId);
        const destCategoryId = String(toCategoryId);

        // load destination issues to compute order positions
        const destIssues = await Issue.find({
            projectId: pid,
            categoryId: toObjectId(destCategoryId),
            archived: false,
            _id: { $ne: issue._id },
        })
            .sort({ order: 1, updatedAt: 1 })
            .session(session);

        const idx = Math.max(0, Math.min(Number(toIndex) || 0, destIssues.length));
        // Insert by setting a temporary order then reindex
        destIssues.splice(idx, 0, issue);

        // apply new categoryId and order in one pass
        const bulk = destIssues.map((d, i) => ({
            updateOne: {
                filter: { _id: d._id },
                update: {
                    $set: {
                        categoryId: toObjectId(destCategoryId),
                        order: i * 1000,
                    },
                    $push: d._id.equals(issue._id)
                        ? { activity: { type: "moved", userId: toObjectId(userId), meta: { fromCategoryId, toCategoryId: destCategoryId } } }
                        : undefined,
                },
            },
        }));

        // bulkWrite doesn't like undefined in update; build clean ops
        const cleanBulk = bulk.map((op) => {
            const u = op.updateOne.update;
            if (!u.$push) delete u.$push;
            return op;
        });

        if (cleanBulk.length) await Issue.bulkWrite(cleanBulk, { session });

        // Reindex source column as well if moved across columns
        if (fromCategoryId !== destCategoryId) {
            await reindexOrder(Issue, { projectId: pid, categoryId: toObjectId(fromCategoryId), archived: false }, 1000, session);
        }

        // notify assignees (optional)
        const assignees = (issue.assigneeIds || []).map((x) => String(x)).filter(Boolean);
        if (assignees.length) {
            const notis = assignees.map((aid) => ({
                userId: toObjectId(aid),
                projectId: pid,
                issueId: issue._id,
                type: "issue_moved",
                title: "Task moved",
                message: issue.title,
                meta: { issueId: String(issue._id), fromCategoryId, toCategoryId: destCategoryId },
            }));
            await Notification.insertMany(notis, { session });
        }

        await session.commitTransaction();
        return res.json({ message: "OK" });
    } catch (e) {
        await session.abortTransaction();
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    } finally {
        session.endSession();
    }
}

async function archiveIssue(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;

        await assertProjectMember({ projectId, userId });

        const doc = await Issue.findOneAndUpdate(
            { _id: toObjectId(issueId), projectId: toObjectId(projectId) },
            { $set: { archived: true } },
            { new: true }
        ).lean();

        if (!doc) return res.status(404).json({ message: "Issue not found" });
        return res.json({ data: doc });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

module.exports = {
    createIssue,
    getBoard,
    updateIssue,
    addComment,
    moveIssue,
    archiveIssue,
};
