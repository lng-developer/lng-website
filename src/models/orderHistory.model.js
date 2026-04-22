// orderHistory.model.js
const mongoose = require("mongoose");

const orderHistorySchema = new mongoose.Schema(
    {
        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "OrderCustomProduct",
            index: true,
            required: true,
        },
        orderId: { type: String, index: true }, // để search nhanh theo orderId Amazon

        action: {
            type: String,
            enum: [
                "CREATE_ORDER",
                "UPDATE_STATUS",
                "UPDATE_SCALE_STATUS",
                "UPDATE_ITEM_TRACKING",
                "UPDATE_CS_NOTE",
                "UPDATE_QC_NOTE",
                "UPDATE_ADDRESS",
                "UPDATE_BASE_COST",
                "UPDATE_ITEM_QUANTITY",
                "SYNC_AMAZON_FINANCE",
                "SEND_TO_VENDOR",
                "OPEN_CASE",
                "REMOVE_CASE",
                "MARK_ADDRESS_VALID",
                "UPLOAD_FULFILLMENT_FILES",
                "SCALE_APPROVE_ITEM",
                "SCALE_REJECT_ITEM",
                "SCALE_ORDER_READY",
                "SEND_TO_VENDOR",
                "SEND_TO_VENDOR_FAILED",
                "UPDATE_ITEM_TRACKING_BULK",
                "OTHER"
            ],
            required: true,
        },

        description: { type: String, default: "" },

        // Chi tiết field thay đổi
        changes: [
            {
                field: String,  // "status", "scale_overall_status", "items.0.tracking_info.tracking", ...
                from: mongoose.Schema.Types.Mixed,
                to: mongoose.Schema.Types.Mixed,
            },
        ],

        // Nếu log ở level item:
        orderItemId: { type: String, default: null },

        // Ai làm
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        userName: { type: String, default: null },
        userRole: { type: String, default: null },

        // Ngữ cảnh:
        source: {
            type: String,
            enum: ["PORTAL", "CRONJOB", "API_AMAZON", "SYSTEM", "SCRIPT"],
            default: "PORTAL",
        },
        ip: { type: String, default: null },
        userAgent: { type: String, default: null },

        createdAt: { type: Date, default: Date.now },
    },
    {
        timestamps: false,
    }
);

orderHistorySchema.index({ orderId: 1, createdAt: -1 });

module.exports = mongoose.model("OrderHistory", orderHistorySchema);
