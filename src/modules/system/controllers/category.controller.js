const categoryService = require('../services/category.service');
const { getUserId } = require("../helpers/toDoList.helper.js");

async function listCategories(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const { includeArchived = "false" } = req.query || {};

        const data = await categoryService.listCategories(projectId, userId, includeArchived);
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function createCategory(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;

        const data = await categoryService.createCategory(projectId, userId, req.body || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function updateCategory(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, categoryId } = req.params;

        const data = await categoryService.updateCategory(projectId, categoryId, userId, req.body || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function reorderCategories(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const { orderedCategoryIds } = req.body || {};

        const result = await categoryService.reorderCategories(projectId, userId, orderedCategoryIds);
        return res.json(result);
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function archiveCategory(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, categoryId } = req.params;

        const data = await categoryService.archiveCategory(projectId, categoryId, userId);
        return res.json({ data });
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

