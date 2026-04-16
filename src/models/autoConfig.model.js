const mongoose = require("mongoose");

const autoConfigSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["IMPORT_ORDER", "IMPORT_ADS", "IMPORT_FBM", "UPLOAD_TRACKING", "PULL_TRACKING"],
      required: true,
    },
    status: {
      type: Boolean,
      default: true,
    },
    time: {
      type: Number, // phút
      required: true,
    },
    shopId: {
      type: String,
      required: true,
    },
    shopName: {
      type: String,
      required: true,
    },
    describe: {
      type: String,
      default: "",
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: "updated_at" } }
);

module.exports = mongoose.model("AutoConfig", autoConfigSchema);
