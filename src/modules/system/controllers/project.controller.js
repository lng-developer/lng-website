// src/modules/system/controllers/project.controller.js
const projectService = require('../services/project.service');
const { getUserId } = require("../helpers/toDoList.helper.js");

async function createProject(req, res) {
    try {
        const userId = getUserId(req);
        const data = await projectService.createProject(userId, req.body || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function listProjects(req, res) {
    try {
        const userId = getUserId(req);
        const data = await projectService.listProjects(userId, req.query || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function getProjectDetail(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const data = await projectService.getProjectDetail(userId, projectId);
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function updateProject(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const data = await projectService.updateProject(userId, projectId, req.body || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function archiveProject(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const data = await projectService.archiveProject(userId, projectId);
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

module.exports = {
    createProject,
    listProjects,
    getProjectDetail,
    updateProject,
    archiveProject,
};

