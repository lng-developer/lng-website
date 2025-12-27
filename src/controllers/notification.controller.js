// controllers/trello/notification.controller.js
const db = require("../models");
const Notification = db.Notification
const { toObjectId, getUserId } = require("../helper/toDoList.helper.js");

async function listNotifications(req, res) {
    try {
        const userId = toObjectId(getUserId(req));
        const { isRead, projectId, issueId, limit = 50, skip = 0 } = req.query || {};

        const q = { userId, isArchived: false };
        if (isRead === "true") q.isRead = true;
        if (isRead === "false") q.isRead = false;
        if (projectId) q.projectId = toObjectId(projectId);
        if (issueId) q.issueId = toObjectId(issueId);

        const data = await Notification.find(q)
            .sort({ createdAt: -1 })
            .skip(Number(skip) || 0)
            .limit(Math.min(Number(limit) || 50, 200))
            .lean();

        return res.json({ data });
    } catch (e) {
        return res.status(500).json({ message: e.message || "Server error" });
    }
}

async function markRead(req, res) {
    try {
        const userId = toObjectId(getUserId(req));
        const { notificationId } = req.params;

        const doc = await Notification.findOneAndUpdate(
            { _id: toObjectId(notificationId), userId },
            { $set: { isRead: true } },
            { new: true }
        ).lean();

        if (!doc) return res.status(404).json({ message: "Notification not found" });
        return res.json({ data: doc });
    } catch (e) {
        return res.status(500).json({ message: e.message || "Server error" });
    }
}

async function markAllRead(req, res) {
    try {
        const userId = toObjectId(getUserId(req));
        const { projectId } = req.query || {};
        const q = { userId, isRead: false, isArchived: false };
        if (projectId) q.projectId = toObjectId(projectId);

        await Notification.updateMany(q, { $set: { isRead: true, readAt: new Date() } });
        return res.json({ message: "OK" });
    } catch (e) {
        return res.status(500).json({ message: e.message || "Server error" });
    }
}

async function archiveNotification(req, res) {
    try {
        const userId = toObjectId(getUserId(req));
        const { notificationId } = req.params;

        const doc = await Notification.findOneAndUpdate(
            { _id: toObjectId(notificationId), userId },
            { $set: { isArchived: true } },
            { new: true }
        ).lean();

        if (!doc) return res.status(404).json({ message: "Notification not found" });
        return res.json({ data: doc });
    } catch (e) {
        return res.status(500).json({ message: e.message || "Server error" });
    }
}

module.exports = {
    listNotifications,
    markRead,
    markAllRead,
    archiveNotification,
};
