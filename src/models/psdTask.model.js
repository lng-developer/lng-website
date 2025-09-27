// models/PsdTask.js
const mongoose = require("mongoose");

const historySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  from: String,
  to: String,
  action: String,
  note: String,
});

const psdTaskSchema = new mongoose.Schema(
  {
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Listing",
      index: true,
      unique: true,
    },
    status: {
      type: String,
      enum: [
        "New",
        "Unavailable",
        "Requested",
        "Assigned",
        "In Progress",
        "Uploaded",
        "QC Rejected",
        "QC Passed",
        "Cancelled",
      ],
      default: "New",
      index: true,
    },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    leader: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    designer: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    priority: {
      type: String,
      enum: ["Low", "Normal", "High", "Urgent"],
      default: "Normal",
    },
    dueAt: Date,
    qc: {
      result: { type: String, enum: ["pass", "reject", null], default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: Date,
      note: String,
    },
    revisionCount: { type: Number, default: 0 },
    history: [historySchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("PsdTask", psdTaskSchema);
