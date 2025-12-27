// models/Notification.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const NotificationSchema = new Schema(
    {
        // receiver
        userId: { type: Types.ObjectId, ref: "User", required: true, index: true },

        // scope
        projectId: { type: Types.ObjectId, ref: "Project", default: null, index: true },
        issueId: { type: Types.ObjectId, ref: "Issue", default: null, index: true },

        // event
        type: {
            type: String,
            enum: [
                "issue_created",
                "issue_updated",
                "issue_assigned",
                "issue_moved",
                "issue_comment",
                "due_soon",
                "overdue",
                "mention",
            ],
            required: true,
            index: true,
        },

        title: { type: String, default: "" },
        message: { type: String, default: "" },

        meta: { type: Schema.Types.Mixed, default: {} },

        // states
        isRead: { type: Boolean, default: false, index: true },
        readAt: { type: Date, default: null },
        isArchived: { type: Boolean, default: false, index: true },
    },
    { timestamps: true }
);

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, projectId: 1, createdAt: -1 });

// NEW: helpful when filtering notifications for a specific issue
NotificationSchema.index({ userId: 1, issueId: 1, createdAt: -1 });

NotificationSchema.pre("save", function (next) {
    if (this.isModified("isRead") && this.isRead && !this.readAt) this.readAt = new Date();
    if (this.isModified("isRead") && !this.isRead) this.readAt = null;
    next();
});

module.exports = mongoose.model("Notification", NotificationSchema);
