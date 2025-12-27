// controllers/trello/helpers.js
const db = require("../models");
const mongoose = require("mongoose");
const Project = db.Project
const Category = db.Category

function toObjectId(id) {
    if (!id) return null;
    if (id instanceof mongoose.Types.ObjectId) return id;
    return new mongoose.Types.ObjectId(String(id));
}

function getUserId(req) {
    return req?.user?.userId || req?.user?._id || "";
}

async function assertProjectMember({ projectId, userId }) {
    const pid = toObjectId(projectId);
    const uid = toObjectId(userId);
    const project = await Project.findById(pid).lean();
    if (!project) {
        const err = new Error("Project not found");
        err.status = 404;
        throw err;
    }
    const isMember =
        String(project.ownerId) === String(uid) ||
        (Array.isArray(project.memberIds) && project.memberIds.some((m) => String(m) === String(uid)));

    if (!isMember) {
        const err = new Error("Access denied: not a project member");
        err.status = 403;
        throw err;
    }
    return project;
}

async function assertCategoryInProject({ categoryId, projectId }) {
    const cat = await Category.findOne({
        _id: toObjectId(categoryId),
        projectId: toObjectId(projectId),
        archived: false,
    }).lean();

    if (!cat) {
        const err = new Error("Category not found in project");
        err.status = 404;
        throw err;
    }
    return cat;
}

/**
 * Reindex: set order = i * step (0, 1000, 2000...)
 * filter: query filter
 */
async function reindexOrder(Model, filter, step = 1000, session = null) {
    const docs = await Model.find(filter).sort({ order: 1, updatedAt: 1 }).session(session || undefined);
    const bulk = docs.map((d, i) => ({
        updateOne: {
            filter: { _id: d._id },
            update: { $set: { order: i * step } },
        },
    }));
    if (bulk.length) await Model.bulkWrite(bulk, { session: session || undefined });
    return docs.length;
}

function parseIntSafe(v, def = 0) {
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) ? n : def;
}

module.exports = {
    toObjectId,
    getUserId,
    assertProjectMember,
    assertCategoryInProject,
    reindexOrder,
    parseIntSafe
};
