// report_latest_65_vendor_base_cost.js
// Lấy 65 đơn mới nhất, xác định vendor qua items[0].cost_breakdown.vendorProductId
// -> VendorProduct.vendor_id -> Vendor.name
// Group theo vendor, cộng base_cost, quy đổi VND theo tỉ giá 27.700
// Output dạng:
// Lượng đơn Pending:
// - Merchize: Pending X đơn - $YYY.yy
// ...
// Tổng: Pending XX đơn - $ZZZ.zz (nnn.vnđ)

// =============================
// CONFIG
// =============================
const mongoose = require("mongoose");

const MONGODB_URI =
    process.env.MONGODB_URI || "mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net/lng_db?retryWrites=true&w=majority&appName=LNGWeb";

// Số lượng đơn cần lấy
const LIMIT_ORDERS = 57;

// Tỉ giá
const EXCHANGE_RATE = 27700;

// Tên collection trong MongoDB
// Sửa cho đúng nếu bạn đang dùng tên khác
const ORDER_COLLECTION = "ordercustomproducts";
const VENDOR_PRODUCT_COLLECTION = "vendorproducts";
const VENDOR_COLLECTION = "vendors";

// =============================
// FORMAT HELPERS
// =============================
function formatUSD(n) {
    if (typeof n !== "number") return n;
    return n.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function formatVND(n) {
    if (typeof n !== "number") return n;
    return n.toLocaleString("vi-VN");
}

// Map tên vendor nếu bạn muốn chuẩn hóa
const VENDOR_NAME_MAP = {
    Merchize: "Merchize",
    Printway: "Printway",
    MangoPrint: "MangoPrint",
    Beeful: "Beeful",
    Merchfox: "Merchfox",
    MerchFox: "Merchfox",
};

function normalizeVendorName(name) {
    if (!name) return "Unknown";
    const raw = String(name).trim();
    if (VENDOR_NAME_MAP[raw]) return VENDOR_NAME_MAP[raw];
    return raw;
}

// =============================
// MAIN
// =============================
async function main() {
    try {
        console.log("Connecting to MongoDB...");
        await mongoose.connect(MONGODB_URI);
        console.log("MongoDB connected.");

        const OrderColl = mongoose.connection.collection(ORDER_COLLECTION);

        // Pipeline:
        // 1. Sort 65 đơn mới nhất theo createdAt
        // 2. Lấy items[0].cost_breakdown.vendorProductId
        // 3. Convert sang ObjectId
        // 4. Lookup sang vendorproducts
        // 5. Lookup sang vendors
        // 6. Group theo vendor.name, cộng base_cost
        const pipeline = [
            {
                $sort: { createdAt: -1 },
            },
            {
                $limit: LIMIT_ORDERS,
            },
            // lấy item đầu tiên
            {
                $addFields: {
                    firstItem: { $arrayElemAt: ["$items", 0] },
                },
            },
            {
                $addFields: {
                    vendorProductIdStr: "$firstItem.cost_breakdown.vendorProductId",
                },
            },
            {
                $addFields: {
                    vendorProductId: {
                        $cond: [
                            {
                                $and: [
                                    { $ne: ["$vendorProductIdStr", null] },
                                    { $ne: ["$vendorProductIdStr", ""] },
                                ],
                            },
                            { $toObjectId: "$vendorProductIdStr" },
                            null,
                        ],
                    },
                },
            },
            {
                $lookup: {
                    from: VENDOR_PRODUCT_COLLECTION,
                    localField: "vendorProductId",
                    foreignField: "_id",
                    as: "vendorProduct",
                },
            },
            {
                $unwind: {
                    path: "$vendorProduct",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $lookup: {
                    from: VENDOR_COLLECTION,
                    localField: "vendorProduct.vendor_id",
                    foreignField: "_id",
                    as: "vendor",
                },
            },
            {
                $unwind: {
                    path: "$vendor",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $group: {
                    _id: "$vendor.name", // có thể null nếu không match được
                    totalOrders: { $sum: 1 },
                    totalBaseCostUSD: { $sum: "$base_cost" },
                },
            },
            {
                $sort: { _id: 1 },
            },
        ];

        const aggResult = await OrderColl.aggregate(pipeline).toArray();

        if (!aggResult.length) {
            console.log("Không tìm thấy đơn nào (pipeline trả về rỗng).");
            return;
        }

        // Tính tổng
        let totalOrders = 0;
        let totalUSD = 0;

        const rows = aggResult.map((row) => {
            const vendorName = normalizeVendorName(row._id);
            const orders = row.totalOrders || 0;
            const usd = row.totalBaseCostUSD || 0;

            totalOrders += orders;
            totalUSD += usd;

            return {
                vendorName,
                orders,
                usd,
            };
        });

        const totalVND = totalUSD * EXCHANGE_RATE;

        // In ra giống template
        console.log(`Lượng đơn Pending (65 đơn mới nhất theo createdAt):`);

        rows.forEach((r) => {
            console.log(
                `- ${r.vendorName}: Pending ${r.orders} đơn - $${formatUSD(r.usd)}`
            );
        });

        console.log(
            `Tổng: Pending ${totalOrders} đơn - $${formatUSD(
                totalUSD
            )} (${formatVND(
                totalVND
            )} vnđ, tỉ giá ${EXCHANGE_RATE.toLocaleString("vi-VN")})`
        );
    } catch (err) {
        console.error("Có lỗi xảy ra:", err);
    } finally {
        await mongoose.disconnect();
        console.log("MongoDB disconnected.");
    }
}

main();
