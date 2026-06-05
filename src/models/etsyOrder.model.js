const mongoose = require("mongoose");
const { Schema } = mongoose;

const EtsyOrderItemEmbeddedSchema = new Schema(
    {
        transactionId: { type: String, required: true }, // unique in order (enforce by import logic)
        listingId: { type: String, index: true },
        sku: { type: String, index: true },

        itemName: { type: String },
        quantity: { type: Number, min: 1 },
        unitPrice: { type: Number, min: 0 },
        itemTotal: { type: Number, min: 0 },

        variationsRaw: { type: String },
        variations: { type: Schema.Types.Mixed, default: {} },
        cost_breakdown: { type: Schema.Types.Mixed, default: null },

        baseImage: {
            imageUrl: String,
            width: Number,
            height: Number,
        },

        tracking_info: {
            fulfillment: { type: String },
            tracking: { type: String },
            status: { type: String },
            note: { type: String },
            updated_at: { type: Date },
        },

        fulfillment_file: {
            type: Map,
            of: String,
            default: {},
        },

        scale_status: {
            type: String,
            enum: ["Need Scale", "Pending", "Complete", "QC Rejected", "Cancelled"],
            default: "Need Scale",
        },

        qc_note: { type: String, trim: true, default: "" },
        cs_note: { type: String, trim: true, default: "" },

        manual_vendor_cost_center_id: {
            type: Schema.Types.ObjectId,
            ref: "VendorCostCenter",
            default: null,
        },
    },
    { _id: false }
);

const EtsyOrderSchema = new Schema(
    {
        orderId: { type: String, required: true, index: true },
        shopId: {
            type: Schema.Types.ObjectId,
            ref: "Shop",
            required: true,
            index: true
        },

        // Dates
        saleDate: { type: Date, index: true },
        paidAt: { type: Date, index: true },
        shippedAt: { type: Date, index: true },

        status: { type: String, index: true, default: "New" },

        // Classification / payment
        orderType: { type: String },
        listingsType: { type: String },
        paymentType: { type: String },
        paymentMethod: { type: String },
        currency: { type: String, maxlength: 3 },

        // Buyer snapshot (SoldOrders richer)
        buyer: {
            userId: { type: String, index: true },
            fullName: { type: String },
            firstName: { type: String },
            lastName: { type: String },
            display: { type: String }, // fallback from items
        },

        // ... trong file model, ở đoạn schema Order-level
        seller: {
            sellerId: { type: Schema.Types.ObjectId, ref: "User", index: true }, // <- nếu model name user khác, đổi ở đây
            sellerCode: { type: String, index: true }, // ví dụ: J2512
        },

        coupon: {
            code: { type: String },
            details: { type: String },
        },

        shipping: {
            name: { type: String }, // from items: Ship Name
            address1: { type: String }, // from orders: Street 1
            address2: { type: String }, // from orders: Street 2
            city: { type: String },
            state: { type: String },
            zipcode: { type: String },
            country: { type: String },
        },

        // Shipping type (không có sẵn trong CSV Etsy mặc định, nhưng cần cho tính cost nếu bạn map)
        shipping_type: {
            type: String,
            enum: ["SecondDay", "Ground", "Overnight", "Economy", "Standard", "Expedited"],
            default: "Standard",
        },

        totals: {
            // SoldOrders
            orderValue: { type: Number },
            shipping: { type: Number },
            salesTax: { type: Number },
            orderTotal: { type: Number },
            cardProcessingFees: { type: Number },
            orderNet: { type: Number },

            fee: { type: Number },

            adjustedOrderTotal: { type: Number },
            adjustedCardProcessingFees: { type: Number },
            adjustedNet: { type: Number },
            adjustedOrderValue: { type: Number },
            adjustedShipping: { type: Number },
            adjustedSalesTax: { type: Number },

            // SoldOrderItems
            orderShipping: { type: Number },
            orderSalesTax: { type: Number },
            discountAmount: { type: Number },
            shippingDiscount: { type: Number },
            inPersonDiscount: { type: Number },
            vatPaidByBuyer: { type: Number },
        },

        base_cost: { type: Number, default: 0 },
        base_cost_computed_at: { type: Date, default: null },
        base_cost_shipping_groups: { type: Schema.Types.Mixed, default: [] },

        scale_overall_status: {
            type: String,
            enum: [
                "Need Scale",
                "Pending",
                "Ready",
                "Sent",
                "Failed",
                "QC Rejected",
                "Cancelled",
                "Address Invalid",
            ],
            default: "Need Scale",
            index: true,
        },

        scaleId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        csAssigneeId: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        csAssignedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        csAssignedAt: {
            type: Date,
            default: null,
        },

        cs_assignment_status: {
            type: String,
            enum: ["Unassigned", "Assigned", "In Progress", "Done"],
            default: "Unassigned",
            index: true,
        },

        forced_vendor_id: {
            type: Schema.Types.ObjectId,
            ref: "Vendor",
            default: null,
        },

        numberOfItems: { type: Number, default: 0 },
        sumbittedoetsy: { type: Boolean, default: false },

        items: { type: [EtsyOrderItemEmbeddedSchema], default: [] },
        address_validation: {
            provider: { type: String, default: "smarty" },
            scope: { type: String, default: "etsy_us_street" },
            envSource: { type: String, default: "ETSY_US_STREET_SMARTY_*" },
            status: {
                type: String,
                enum: [
                    "valid",
                    "invalid",
                    "pending",
                    "credentials_missing",
                    "auth_error",
                    "subscription_error",
                    "rate_limit",
                    "service_error",
                    "unexpected_status",
                    null,
                ],
                default: null,
            },
            isValid: { type: Boolean, default: null },
            checkedAt: { type: Date, default: null },
            httpStatus: { type: Number, default: null },
            errorCode: { type: String, default: null },
            errorMessage: { type: String, default: null },
            retryable: { type: Boolean, default: false },
            accountIssue: { type: Boolean, default: false },
            request: { type: Schema.Types.Mixed, default: null },
            smartyResponse: { type: Schema.Types.Mixed, default: null },
        },
    },
    { timestamps: true, versionKey: false }
);

// Index hỗ trợ query/report
EtsyOrderSchema.index({ shopId: 1, orderId: 1 }, { unique: true });
EtsyOrderSchema.index({ shopId: 1, "items.listingId": 1 });
EtsyOrderSchema.index({ shopId: 1, "items.sku": 1 });
EtsyOrderSchema.index({ saleDate: -1 });
EtsyOrderSchema.index({ "items.sku": 1 });
EtsyOrderSchema.index({ "items.listingId": 1 });
EtsyOrderSchema.index({ saleDate: 1, "items.sku": 1 });

module.exports = mongoose.model("EtsyOrder", EtsyOrderSchema);
