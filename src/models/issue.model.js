// models/Issue.js  (Trello card)
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const IssueCommentSchema = new Schema(
    {
        userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
        content: { type: String, required: true },
        attachments: [
            {
                name: { type: String, default: "" },
                url: { type: String, required: true },
                mime: { type: String, default: "" },
                size: { type: Number, default: 0 },
            },
        ],
    },
    { timestamps: true }
);

const AttachmentSchema = new Schema(
    {
        name: { type: String, default: "" },
        url: { type: String, required: true },
        mime: { type: String, default: "" },
        size: { type: Number, default: 0 },
        public_id: { type: String, default: "" }, // NEW: để quản lý xoá/overwrite
    },
    { _id: false }
);

const IssueActivitySchema = new Schema(
    {
        at: { type: Date, default: Date.now, index: true },
        userId: { type: Types.ObjectId, ref: "User", index: true },

        // e.g. "created", "moved", "assigned", "status_changed", "commented"
        type: { type: String, required: true, index: true },

        // free-form payload for auditing
        meta: { type: Schema.Types.Mixed, default: {} },
    },
    { _id: true }
);

const IssueSchema = new Schema(
    {
        projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
        categoryId: { type: Types.ObjectId, ref: "Category", required: true, index: true },
        title: { type: String, required: true, trim: true, index: true },
        description: { type: String, default: "" },
        assigneeIds: [{ type: Types.ObjectId, ref: "User", index: true }],

        // planning fields
        priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium", index: true },
        status: { type: String, enum: ["open", "in_progress", "blocked", "done", "canceled"], default: "open", index: true },
        dueAt: { type: Date, default: null, index: true },
        startAt: { type: Date, default: null },
        doneAt: { type: Date, default: null },
        // ordering inside a column for drag/drop cards
        order: { type: Number, default: 0, index: true },
        attachments: { type: [AttachmentSchema], default: [] },

        // collaboration
        comments: { type: [IssueCommentSchema], default: [] },
        activity: { type: [IssueActivitySchema], default: [] },

        // soft-delete/archive
        archived: { type: Boolean, default: false, index: true },
    },
    { timestamps: true }
);

IssueSchema.index({ projectId: 1, categoryId: 1, order: 1 });
IssueSchema.index({ projectId: 1, status: 1, priority: 1, archived: 1 });
IssueSchema.index({ assigneeIds: 1, dueAt: 1 });

// Useful auto fields
IssueSchema.pre("save", function (next) {
    if (this.isModified("status")) {
        if (this.status === "done" && !this.doneAt) this.doneAt = new Date();
        if (this.status !== "done") this.doneAt = null;
    }
    next();
});

module.exports = mongoose.model("Issue", IssueSchema);
