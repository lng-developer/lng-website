// src/modules/catalog/services/category.service.js
const Category = require("../../catalog/models/category.model");
const mongoose = require('mongoose');
const { toObjectId, assertProjectMember, reindexOrder } = require("../helpers/toDoList.helper.js");

const listCategories = async (projectId, userId, includeArchived) => {
    await assertProjectMember({ projectId, userId });

    const q = { projectId: toObjectId(projectId) };
    if (String(includeArchived) !== "true") q.archived = false;

    return await Category.find(q).sort({ order: 1, createdAt: 1 }).lean();
};

const createCategory = async (projectId, userId, categoryData) => {
    const { name, type = "custom" } = categoryData;
    if (!name || !String(name).trim()) {
        const error = new Error("Missing category name");
        error.status = 400;
        throw error;
    }

    await assertProjectMember({ projectId, userId });

    const session = await mongoose.startSession();
    try {
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
        return cat[0];
    } catch (e) {
        await session.abortTransaction();
        throw e;
    } finally {
        session.endSession();
    }
};

const updateCategory = async (projectId, categoryId, userId, updateData) => {
    const { name, type, archived } = updateData;

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

    if (!doc) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
    }
    return doc;
};

const reorderCategories = async (projectId, userId, orderedCategoryIds) => {
    if (!Array.isArray(orderedCategoryIds) || orderedCategoryIds.length === 0) {
        const error = new Error("orderedCategoryIds is required");
        error.status = 400;
        throw error;
    }

    await assertProjectMember({ projectId, userId });

    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const pid = toObjectId(projectId);
        const ids = orderedCategoryIds.map(toObjectId);

        const existing = await Category.find({ _id: { $in: ids }, projectId: pid }).session(session).lean();
        if (existing.length !== ids.length) {
            const error = new Error("Some categoryId invalid");
            error.status = 400;
            throw error;
        }

        const bulk = ids.map((id, idx) => ({
            updateOne: { filter: { _id: id }, update: { $set: { order: idx * 1000 } } },
        }));
        await Category.bulkWrite(bulk, { session });

        await reindexOrder(Category, { projectId: pid, archived: false }, 1000, session);

        await session.commitTransaction();
        return { message: "OK" };
    } catch (e) {
        await session.abortTransaction();
        throw e;
    } finally {
        session.endSession();
    }
};

const archiveCategory = async (projectId, categoryId, userId) => {
    await assertProjectMember({ projectId, userId });

    const doc = await Category.findOneAndUpdate(
        { _id: toObjectId(categoryId), projectId: toObjectId(projectId) },
        { $set: { archived: true } },
        { new: true }
    ).lean();

    if (!doc) {
        const error = new Error("Category not found");
        error.status = 404;
        throw error;
    }
    return doc;
};

module.exports = {
    listCategories,
    createCategory,
    updateCategory,
    reorderCategories,
    archiveCategory,
};

