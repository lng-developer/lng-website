const mongoose = require("mongoose");

const IdeaTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    referenceLink: { type: String, trim: true, default: "" },
    deadline: { type: Date },

    // Người tạo idea (reference User)
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Người được phân công (reference User)
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    difficulty: {
      type: String,
      enum: ["Easy", "Normal", "Hard", "Extremely"],
      default: "Easy",
    },
    
    status: {
      type: String,
      enum: [
        "New",
        "Assigned",
        "In Progress",
        "Uploaded",
        "QC Rejected",
        "QC Passed",
      ],
      default: "New",
    },

    psd: {
      key: { type: String, default: "" },
      url: { type: String, default: "" },
      uploadedAt: { type: Date },
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },

    history: [
      {
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        action: String,
        meta: mongoose.Schema.Types.Mixed,
      },
    ],

    productType: { type: String, required: true, trim: true, maxlength: 5000 },

    image: { type: String, required: true, trim: true, maxlength: 5000 },
    
    comments: [
      {
        _id: false,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        text: { type: String, trim: true, maxlength: 2000 },
      },
    ],
  },
  { timestamps: true }
);

IdeaTaskSchema.index({ status: 1, assignedTo: 1, deadline: 1, createdAt: -1 });
IdeaTaskSchema.index({ title: "text", description: "text" });

module.exports = mongoose.model("IdeaTask", IdeaTaskSchema);

