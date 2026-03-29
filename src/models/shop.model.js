const mongoose = require("mongoose");

const clientSubSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true },
    label: { type: String, default: "" },
    version: { type: String, default: "" }, // ví dụ: "ext-1.2.3"
    status: { type: String, enum: ["online", "offline"], default: "online" },
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
  },
  { _id: false }
);

const shopSchema = new mongoose.Schema(
  {
    store: { type: String, required: true }, // seller id
    name: { type: String, required: true },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    team: [{ type: String }],
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    merchant: { type: String, required: true },

    // === NEW ===
    autoEnabled: { type: Boolean, default: true },
    clients: { type: [clientSubSchema], default: [] },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

shopSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model("Shop", shopSchema);
