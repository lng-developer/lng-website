const mongoose = require("mongoose");
const { Schema } = mongoose;

const AdsDailySummarySchema = new Schema(
  {
    day: { type: Date, required: true, unique: true, index: true }, // 00:00 UTC của ngày
    total_spend: { type: Number, default: 0 }, // Tổng tất cả seller

    by_seller: [
      {
        seller: {
          _id: { type: Schema.Types.ObjectId, ref: "User", required: true },
          full_name: { type: String, default: "" },
        },

        // Tổng chi tiêu của seller trong ngày
        spend: { type: Number, default: 0 },

        // Chi tiết từng shop
        by_shop: [
          {
            shop_id: {
              type: Schema.Types.ObjectId,
              ref: "Shop",
              required: true,
            },
            spend: { type: Number, default: 0 },
          },
        ],
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdsDailySummary", AdsDailySummarySchema);
