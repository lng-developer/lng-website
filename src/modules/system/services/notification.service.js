// src/modules/system/services/notification.service.js
const db = require("../../../models");
const Notification = db.Notification;
const { toObjectId } = require("../helpers/toDoList.helper.js");

const listNotifications = async (userId, { isRead, projectId, issueId, limit = 50, skip = 0 }) => {
    const q = { userId: toObjectId(userId), isArchived: false };
    if (isRead === "true") q.isRead = true;
    if (isRead === "false") q.isRead = false;
    if (projectId) q.projectId = toObjectId(projectId);
    if (issueId) q.issueId = toObjectId(issueId);

    return await Notification.find(q)
        .sort({ createdAt: -1 })
        .skip(Number(skip) || 0)
        .limit(Math.min(Number(limit) || 50, 200))
        .lean();
};

const markRead = async (userId, notificationId) => {
    const doc = await Notification.findOneAndUpdate(
        { _id: toObjectId(notificationId), userId: toObjectId(userId) },
        { $set: { isRead: true } },
        { new: true }
    ).lean();

    if (!doc) {
        const error = new Error("Notification not found");
        error.status = 404;
        throw error;
    }
    return doc;
};

const markAllRead = async (userId, { projectId }) => {
    const q = { userId: toObjectId(userId), isRead: false, isArchived: false };
    if (projectId) q.projectId = toObjectId(projectId);

    await Notification.updateMany(q, { $set: { isRead: true, readAt: new Date() } });
    return { message: "OK" };
};

const archiveNotification = async (userId, notificationId) => {
    const doc = await Notification.findOneAndUpdate(
        { _id: toObjectId(notificationId), userId: toObjectId(userId) },
        { $set: { isArchived: true } },
        { new: true }
    ).lean();

    if (!doc) {
        const error = new Error("Notification not found");
        error.status = 404;
        throw error;
    }
    return doc;
};

module.exports = {
    listNotifications,
    markRead,
    markAllRead,
    archiveNotification,
};

