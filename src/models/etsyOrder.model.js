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
    },
    { _id: false }
);

const EtsyOrderSchema = new Schema(
    {
        orderId: { type: String, required: true, unique: true, index: true },
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

        numberOfItems: { type: Number, default: 0 },

        items: { type: [EtsyOrderItemEmbeddedSchema], default: [] },
        address_validation: {
            isValid: { type: Boolean, default: null },
            smartyResponse: { type: Object, default: null },
        },
    },
    { timestamps: true, versionKey: false }
);

// Index hỗ trợ query/report
EtsyOrderSchema.index({ saleDate: -1 });
EtsyOrderSchema.index({ "items.sku": 1 });
EtsyOrderSchema.index({ "items.listingId": 1 });
EtsyOrderSchema.index({ saleDate: 1, "items.sku": 1 });

module.exports = mongoose.model("EtsyOrder", EtsyOrderSchema);
