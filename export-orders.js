// export-orders.js
// Chạy: node export-orders.js

const { MongoClient, ObjectId } = require("mongodb");
const fs = require("fs");
const path = require("path");

// TODO: Sửa lại cho đúng với hệ thống của bạn
const MONGO_URI = "mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net/lng_db?retryWrites=true&w=majority&appName=LNGWeb"; // hoặc lấy từ process.env.MONGO_URI
const DB_NAME = "lng_db";                         // tên database
const ORDER_COLLECTION = "ordercustomproducts"; // collection lưu order
const SHOP_COLLECTION = "shops";               // collection lưu shop (shopId -> name)

// ⚠️ THAY shopId CỦA ACC 1
const ACC1_SHOP_ID = "6881aba9c1bbdfc541b5cd4d";

// Format ngày dd/mm/yyyy
function formatDate(date) {
    if (!date) return "";
    const d = new Date(date);
    return `${String(d.getDate()).padStart(2, "0")}/${String(
        d.getMonth() + 1
    ).padStart(2, "0")}/${d.getFullYear()}`;
}

function escapeCsv(value) {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (str.includes('"') || str.includes(",") || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

async function main() {
    const client = new MongoClient(MONGO_URI);

    try {
        await client.connect();
        const db = client.db(DB_NAME);
        const ordersCol = db.collection(ORDER_COLLECTION);

        const cursor = ordersCol.aggregate([
            // ❌ Bỏ toàn bộ đơn thuộc shopId acc1
            {
                $match: {
                    shopId: { $ne: new ObjectId(ACC1_SHOP_ID) },
                },
            },

            // Join lấy tên shop
            {
                $lookup: {
                    from: SHOP_COLLECTION,
                    localField: "shopId",
                    foreignField: "_id",
                    as: "shop",
                },
            },
            {
                $unwind: {
                    path: "$shop",
                    preserveNullAndEmptyArrays: true,
                },
            },

            // Chỉ lấy field cần export
            {
                $project: {
                    orderId: 1,
                    purchase_date: 1,
                    base_cost: 1,
                    shopName: "$shop.name",
                    amazon_finance_total: 1,
                },
            },
        ]);

        const rows = [];

        // Header CSV
        const header = [
            "orderId",
            "purchaseDate",
            "shopName",
            "base_cost",
            "item_price",
            "item_tax",
            "shipping_price",
            "shipping_tax",
            "item_promotion_discount",
            "fee",
            "revenue",
            "opCost",
            "refund",
            "profit1",
            "profit2",
            "currency",
            "finance_computed_at",
        ];

        rows.push(header.join(","));

        for await (const doc of cursor) {
            const finance = doc.amazon_finance_total || {};

            const row = [
                escapeCsv(doc.orderId),
                escapeCsv(formatDate(doc.purchase_date)),
                escapeCsv(doc.shopName || ""),
                escapeCsv(doc.base_cost ?? ""),

                escapeCsv(finance.item_price ?? ""),
                escapeCsv(finance.item_tax ?? ""),
                escapeCsv(finance.shipping_price ?? ""),
                escapeCsv(finance.shipping_tax ?? ""),
                escapeCsv(finance.item_promotion_discount ?? ""),
                escapeCsv(finance.fee ?? ""),
                escapeCsv(finance.revenue ?? ""),
                escapeCsv(finance.opCost ?? ""),
                escapeCsv(finance.refund ?? ""),
                escapeCsv(finance.profit1 ?? ""),
                escapeCsv(finance.profit2 ?? ""),
                escapeCsv(finance.currency ?? ""),
                escapeCsv(
                    finance.computed_at ? formatDate(finance.computed_at) : ""
                ),
            ];

            rows.push(row.join(","));
        }

        const filePath = path.join(__dirname, "orders_export.csv");
        fs.writeFileSync(filePath, rows.join("\n"), "utf8");

        console.log("✅ Export xong (đã loại shopId acc1):", filePath);
    } catch (err) {
        console.error("❌ Lỗi:", err);
    } finally {
        await client.close();
    }
}

main();
