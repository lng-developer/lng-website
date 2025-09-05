const mongoose = require("mongoose");
const { Schema } = mongoose;

const AdsDailySummarySchema = new Schema(
  {
    day: { type: Date, required: true, unique: true, index: true }, // 00:00 UTC của ngày
    total_spend: { type: Number, default: 0 },
    // Lưu chi tiết theo seller (tiện debug/đối soát)
    by_seller: [
      {
        seller: {
          _id: { type: Schema.Types.ObjectId, ref: "User", required: true },
          full_name: { type: String, default: "" },
        },
        spend: { type: Number, default: 0 },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ads", AdsDailySummarySchema);
