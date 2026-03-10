// src/modules/system/controllers/notification.controller.js
const notificationService = require('../services/notification.service');
const { getUserId } = require("../helpers/toDoList.helper.js");

async function listNotifications(req, res) {
    try {
        const userId = getUserId(req);
        const data = await notificationService.listNotifications(userId, req.query || {});
        return res.json({ data });
    } catch (e) {
        return res.status(500).json({ message: e.message || "Server error" });
    }
}

async function markRead(req, res) {
    try {
        const userId = getUserId(req);
        const { notificationId } = req.params;
        const data = await notificationService.markRead(userId, notificationId);
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

async function markAllRead(req, res) {
    try {
        const userId = getUserId(req);
        const result = await notificationService.markAllRead(userId, req.query || {});
        return res.json(result);
    } catch (e) {
        return res.status(500).json({ message: e.message || "Server error" });
    }
}

async function archiveNotification(req, res) {
    try {
        const userId = getUserId(req);
        const { notificationId } = req.params;
        const data = await notificationService.archiveNotification(userId, notificationId);
        return res.json({ data });
    } catch (e) {
        return res.status(e.status || 500).json({ message: e.message || "Server error" });
    }
}

module.exports = {
    listNotifications,
    markRead,
    markAllRead,
    archiveNotification,
};

