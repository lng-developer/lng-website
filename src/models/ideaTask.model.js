const mongoose = require("mongoose");

const IdeaTaskSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true, maxlength: 200 },
        description: { type: String, required: true, trim: true, maxlength: 5000 },
        referenceLink: { type: String, trim: true, default: "" },
        deadline: { type: Date },

        // Người tạo idea
        createdBy: {
            userId: { type: String, required: true },
            name: { type: String, default: "" },
        },

        // Phân công
        assignedTo: {
            userId: { type: String, default: "" },
            name: { type: String, default: "" },
        },

        // Độ khó (1-5)
        difficulty: { type: Number, min: 1, max: 5 },

        // Trạng thái
        status: {
            type: String,
            enum: [
                "New",        // người dùng tạo xong
                "Assigned",   // design leader set difficulty + assign
                "In Progress",
                "Submitted",  // designer đã up PSD
                "Approved",
                "Rejected",
                "Archived",
            ],
            default: "New",
        },

        // Tệp PSD lưu trên Wasabi
        psd: {
            key: { type: String, default: "" },   // wasabi object key
            url: { type: String, default: "" },   // pre-signed/public url
            uploadedAt: { type: Date },
            uploadedBy: {
                userId: { type: String, default: "" },
                name: { type: String, default: "" },
            },
        },

        // Nhật ký thay đổi
        history: [
            {
                at: { type: Date, default: Date.now },
                by: { userId: String, name: String },
                action: String,       // e.g. created, assigned, start, submit, approve, reject, update, delete
                meta: mongoose.Schema.Types.Mixed,
            },
        ],

        // Ghi chú / trao đổi nhanh
        comments: [
            {
                _id: false,
                at: { type: Date, default: Date.now },
                by: { userId: String, name: String },
                text: { type: String, trim: true, maxlength: 2000 },
            },
        ],
    },
    { timestamps: true }
);

IdeaTaskSchema.index({ status: 1, "assignedTo.userId": 1, deadline: 1, createdAt: -1 });
IdeaTaskSchema.index({ title: "text", description: "text" });

module.exports = mongoose.model("IdeaTask", IdeaTaskSchema);
