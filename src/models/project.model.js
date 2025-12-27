// models/Project.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const ProjectSchema = new Schema(
    {
        name: { type: String, required: true, trim: true, index: true },
        description: { type: String, default: "" },
        ownerId: { type: Types.ObjectId, ref: "User", required: true, index: true },
        memberIds: [{ type: Types.ObjectId, ref: "User", index: true }], // quick membership
        status: { type: String, enum: ["active", "archived"], default: "active", index: true },
        stats: {
            issueTotal: { type: Number, default: 0 },
            issueOpen: { type: Number, default: 0 },
            issueDone: { type: Number, default: 0 },
        },
    },
    { timestamps: true }
);

// Ensure owner is a member
ProjectSchema.pre("save", function (next) {
    if (this.ownerId && Array.isArray(this.memberIds)) {
        const exists = this.memberIds.some((id) => String(id) === String(this.ownerId));
        if (!exists) this.memberIds.unshift(this.ownerId);
    }
    next();
});

module.exports = mongoose.model("Project", ProjectSchema);
