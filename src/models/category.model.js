// models/Category.js  (Trello column/list)
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const CategorySchema = new Schema(
    {
        projectId: { type: Types.ObjectId, ref: "Project", required: true, index: true },
        name: { type: String, required: true, trim: true },

        type: {
            type: String,
            enum: ["inprocess", "todo", "canceled", "review", "done", "custom"],
            default: "custom",
        },

        // NEW: ordering for drag/drop columns
        order: { type: Number, default: 0, index: true },

        archived: { type: Boolean, default: false, index: true },
    },
    { timestamps: true }
);

// Useful indexes for board rendering
CategorySchema.index({ projectId: 1, archived: 1, order: 1 });
CategorySchema.index({ projectId: 1, name: 1 }, { unique: false });

module.exports = mongoose.model("Category", CategorySchema);
