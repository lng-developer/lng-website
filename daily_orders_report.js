// daily_orders_report.js
// Xuất báo cáo: số lượng đơn theo ngày ra file Excel

const { MongoClient } = require("mongodb");
const ExcelJS = require("exceljs");

// ================== CONFIG ==================
const MONGODB_URI = "mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net/lng_db?retryWrites=true&w=majority&appName=LNGWeb"; // sửa theo server của bạn
const DB_NAME = "lng_db";                  // tên database
const COLLECTION_NAME = "ordercustomproducts";                // tên collection

// Tên field ngày mua hàng trong collection
// Ví dụ: "purchaseDate" hoặc "PurchaseDate" tùy schema của bạn
const DATE_FIELD = "purchase_date";

// Khoảng thời gian cần xuất (optional)
// Nếu không muốn filter thì để FROM_DATE = null, TO_DATE = null
const FROM_DATE = "2025-11-01";  // dạng YYYY-MM-DD
const TO_DATE = "2025-11-30";    // dạng YYYY-MM-DD

// Tên file Excel output
const OUTPUT_FILE = "daily_orders_report.xlsx";
// ============================================

function buildMatchStage() {
    if (!FROM_DATE && !TO_DATE) return {};

    const range = {};
    if (FROM_DATE) {
        range.$gte = new Date(FROM_DATE + "T00:00:00.000Z");
    }
    if (TO_DATE) {
        // để include full day
        range.$lte = new Date(TO_DATE + "T23:59:59.999Z");
    }
    return { [DATE_FIELD]: range };
}

// format dd/MM/yyyy
function formatDateDDMMYYYY(dateObj) {
    const d = dateObj.getDate().toString().padStart(2, "0");
    const m = (dateObj.getMonth() + 1).toString().padStart(2, "0");
    const y = dateObj.getFullYear();
    return `${d}/${m}/${y}`;
}

async function run() {
    const client = new MongoClient(MONGODB_URI);

    try {
        await client.connect();
        console.log("Connected to MongoDB");

        const db = client.db(DB_NAME);
        const collection = db.collection(COLLECTION_NAME);

        const matchStage = buildMatchStage();

        const pipeline = [
            Object.keys(matchStage).length > 0 ? { $match: matchStage } : null,
            {
                $group: {
                    _id: {
                        year: { $year: `$${DATE_FIELD}` },
                        month: { $month: `$${DATE_FIELD}` },
                        day: { $dayOfMonth: `$${DATE_FIELD}` },
                    },
                    orderCount: { $sum: 1 },
                },
            },
            {
                $sort: {
                    "_id.year": 1,
                    "_id.month": 1,
                    "_id.day": 1,
                },
            },
        ].filter(Boolean); // bỏ null nếu không có match

        const results = await collection.aggregate(pipeline).toArray();

        console.log("Aggregation done. Days found:", results.length);

        // ====== Tạo file Excel ======
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Daily Orders");

        // Header
        worksheet.columns = [
            { header: "Date (dd/MM/yyyy)", key: "date", width: 20 },
            { header: "Orders", key: "orders", width: 10 },
        ];

        let totalOrders = 0;

        for (const row of results) {
            const { year, month, day } = row._id;
            const count = row.orderCount;

            const dateObj = new Date(year, month - 1, day);
            const dateStr = formatDateDDMMYYYY(dateObj);

            totalOrders += count;

            worksheet.addRow({
                date: dateStr,
                orders: count,
            });
        }

        // Thêm dòng tổng
        if (results.length > 0) {
            worksheet.addRow({});
            worksheet.addRow({
                date: "TOTAL",
                orders: totalOrders,
            });
        }

        await workbook.xlsx.writeFile(OUTPUT_FILE);
        console.log(`Report created: ${OUTPUT_FILE}`);

    } catch (err) {
        console.error("Error:", err);
    } finally {
        await client.close();
    }
}

run();
