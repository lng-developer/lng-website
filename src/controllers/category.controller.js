// controllers/trello/category.controller.js
const db = require("../models");
const Category = db.Category
const Issue = db.Issue
const Notification = db.Notification
const mongoose = require('mongoose');
const { toObjectId, getUserId, assertProjectMember, reindexOrder, parseIntSafe } = require("../helper/toDoList.helper.js");

async function listCategories(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const { includeArchived = "false" } = req.query || {};

        await assertProjectMember({ projectId, userId });

        const q = { projectId: toObjectId(projectId) };
        if (String(includeArchived) !== "true") q.archived = false;

        const cats = await Category.find(q).sort({ order: 1, createdAt: 1 }).lean();
        return res.json({ data: cats });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function createCategory(req, res) {
    const session = await mongoose.startSession();
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const { name, type = "custom" } = req.body || {};
        if (!name || !String(name).trim()) return res.status(400).json({ message: "Missing category name" });

        await assertProjectMember({ projectId, userId });

        session.startTransaction();

        const last = await Category.findOne({ projectId: toObjectId(projectId), archived: false })
            .sort({ order: -1 })
            .session(session);

        const nextOrder = (last?.order ?? 0) + 1000;

        const cat = await Category.create(
            [
                {
                    projectId: toObjectId(projectId),
                    name: String(name).trim(),
                    type,
                    order: nextOrder,
                    archived: false,
                },
            ],
            { session }
        );

        await session.commitTransaction();
        return res.json({ data: cat[0] });
    } catch (e) {
        await session.abortTransaction();
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    } finally {
        session.endSession();
    }
}

async function updateCategory(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, categoryId } = req.params;
        const { name, type, archived } = req.body || {};

        await assertProjectMember({ projectId, userId });

        const update = {};
        if (typeof name === "string") update.name = String(name).trim();
        if (typeof type === "string") update.type = type;
        if (typeof archived === "boolean") update.archived = archived;

        const doc = await Category.findOneAndUpdate(
            { _id: toObjectId(categoryId), projectId: toObjectId(projectId) },
            { $set: update },
            { new: true }
        ).lean();

        if (!doc) return res.status(404).json({ message: "Category not found" });
        return res.json({ data: doc });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

/**
 * Reorder columns: pass orderedCategoryIds in the desired order
 * body: { orderedCategoryIds: [id1,id2,...] }
 */
async function reorderCategories(req, res) {
    const session = await mongoose.startSession();
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const { orderedCategoryIds } = req.body || {};
        if (!Array.isArray(orderedCategoryIds) || orderedCategoryIds.length === 0) {
            return res.status(400).json({ message: "orderedCategoryIds is required" });
        }

        await assertProjectMember({ projectId, userId });

        session.startTransaction();

        const pid = toObjectId(projectId);
        const ids = orderedCategoryIds.map(toObjectId);

        // ensure all belong to project
        const existing = await Category.find({ _id: { $in: ids }, projectId: pid }).session(session).lean();
        if (existing.length !== ids.length) return res.status(400).json({ message: "Some categoryId invalid" });

        const bulk = ids.map((id, idx) => ({
            updateOne: { filter: { _id: id }, update: { $set: { order: idx * 1000 } } },
        }));
        await Category.bulkWrite(bulk, { session });

        // optional: normalize in case you want deterministic order after partial ops
        await reindexOrder(Category, { projectId: pid, archived: false }, 1000, session);

        await session.commitTransaction();
        return res.json({ message: "OK" });
    } catch (e) {
        await session.abortTransaction();
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    } finally {
        session.endSession();
    }
}

/**
 * Archive category
 * - Usually you'd move issues elsewhere before archiving.
 * - Here: just set archived = true, keep issues as-is (you can choose to enforce move first in UI).
 */
async function archiveCategory(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, categoryId } = req.params;

        await assertProjectMember({ projectId, userId });

        const doc = await Category.findOneAndUpdate(
            { _id: toObjectId(categoryId), projectId: toObjectId(projectId) },
            { $set: { archived: true } },
            { new: true }
        ).lean();

        if (!doc) return res.status(404).json({ message: "Category not found" });
        return res.json({ data: doc });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

module.exports = {
    listCategories,
    createCategory,
    updateCategory,
    reorderCategories,
    archiveCategory,
};
