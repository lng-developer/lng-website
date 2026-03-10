// src/modules/system/controllers/issue.controller.js
const issueService = require('../services/issue.service');
const { getUserId } = require("../helpers/toDoList.helper.js");

async function createIssue(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const data = await issueService.createIssue(userId, projectId, req.body || {}, req.files || []);
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function addAttachmentFile(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;
        const data = await issueService.addAttachmentFile(userId, projectId, issueId, req.files || []);
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function getBoard(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId } = req.params;
        const data = await issueService.getBoard(userId, projectId, req.query || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function updateIssue(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;
        const data = await issueService.updateIssue(userId, projectId, issueId, req.body || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function addComment(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;
        const data = await issueService.addComment(userId, projectId, issueId, req.body || {});
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function moveIssue(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;
        const result = await issueService.moveIssue(userId, projectId, issueId, req.body || {});
        return res.json(result);
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function archiveIssue(req, res) {
    try {
        const userId = getUserId(req);
        const { projectId, issueId } = req.params;
        const data = await issueService.archiveIssue(userId, projectId, issueId);
        return res.json({ data });
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
    addAttachmentFile,
};

