/**
 * Profit by Category (%COGS, %Fee, %ItemTax, %ShipTax, %Discount, %Profit)
 * Usage:
 *   $env:MONGO_URI="mongodb+srv://user:pass@host/dbname"
 *   node scripts/profit-by-category.js `
 *     --from 2025-09-01 `
 *     --to 2025-10-06 `
 *     --collection ordercustomproducts `
 *     --dateField purchase_date `
 *     --csv .\profit_by_category_all.csv
 */

const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// ====== Helper ======
function arg(k, d) {
    const i = process.argv.indexOf(k);
    return i > -1 ? process.argv[i + 1] : d;
}
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb+srv://lngdeveloperworkspace:lannhi123@lngweb.l3xatze.mongodb.net/lng_db?retryWrites=true&w=majority&appName=LNGWeb";
const FROM = new Date(arg("--from", "2000-01-01"));
const TO_RAW = new Date(arg("--to", "2100-01-01"));
const TO = new Date(TO_RAW.getTime() + 24 * 60 * 60 * 1000); // LT end of day
const SELLER_ID = arg("--sellerId", null);
const SHOP_ID = arg("--shopId", null);
const OUT_CSV = arg("--csv", null);
const FAMILY_FILTER = arg("--family", null);
const INCLUDE_CANCELLED = process.argv.includes("--includeCancelled");
const COLLECTION = arg("--collection", "ordercustomproducts");
const MAP_PATH = arg("--map", null);
const DATE_FIELD = arg("--dateField", "purchase_date");
const DEBUG = true;

// ===== Default category map =====
const DEFAULT_MAP = [
    { category: "Crewneck Sweatshirt", family: "Apparel", patterns: ["crewneck sweatshirt", "gildan 18000", "unisex sweatshirt  gildan 18000"] },
    { category: "Unisex Hoodie", family: "Apparel", patterns: ["unisex hoodie", "hoodie"] },
    { category: "Premium Sweatshirt", family: "Apparel", patterns: ["premium sweatshirt"] },
    { category: "Light Weight Sweatshirt", family: "Apparel", patterns: ["light weight sweatshirt"] },
    { category: "Comfort Color T-Shirt", family: "Apparel", patterns: ["comfort color t-shirt", "comfort colors"] },
    { category: "Premium T-shirt", family: "Apparel", patterns: ["premium t-shirt"] },
    { category: "Unisex T-shirt", family: "Apparel", patterns: ["unisex t-shirt", "t-shirt", "tee"] },
    { category: "Infant T-Shirt", family: "Apparel", patterns: ["infant t-shirt"] },
    { category: "Toddler T-Shirt", family: "Apparel", patterns: ["toddler t-shirt"] },
    { category: "Baby Bodysuit", family: "Apparel", patterns: ["baby bodysuit", "bodysuit"] },
    { category: "Acrylic (Best Selling)", family: "Home & Living", patterns: ["acrylic (best selling)", "acrylic"] },
    { category: "Plastic Board (Best Selling)", family: "Home & Living", patterns: ["plastic board"] },
    { category: "Poster", family: "Home & Living", patterns: ["poster"] },
    { category: "Wood", family: "Home & Living", patterns: ["wood"] },
    { category: "Accent Mug", family: "Home & Living", patterns: ["mug"] },
    { category: "Stained Glass", family: "Home & Living", patterns: ["stained glass"] },
    { category: "Jewelry Dish Tray", family: "Home & Living", patterns: ["jewlery dish", "jewelry dish"] },
    { category: "Napkins", family: "Home & Living", patterns: ["napkins", "napkin"] },
    { category: "Other", family: "Other", patterns: [] },
];

function loadMapMaybe() {
    if (!MAP_PATH) return DEFAULT_MAP;
    try {
        const p = path.resolve(process.cwd(), MAP_PATH);
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        return data;
    } catch (e) {
        console.warn(`[map] Không đọc được ${MAP_PATH}. Dùng map mặc định.`);
        return DEFAULT_MAP;
    }
}
const CATMAP = loadMapMaybe().map((r) => ({
    ...r,
    patterns: (r.patterns || []).map((s) => String(s).toLowerCase()),
}));

function resolveCategory(source) {
    const s = String(source || "").toLowerCase();
    for (const rule of CATMAP) {
        if (rule.patterns?.some((p) => s.includes(p))) return { category: rule.category, family: rule.family || "Other" };
    }
    return { category: "Other", family: "Other" };
}
const to2 = (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : 0);

// ====== MAIN ======
(async () => {
    const DynamicSchema = new mongoose.Schema({}, { strict: false, collection: COLLECTION });
    const Coll = mongoose.model("AnyOrder", DynamicSchema, COLLECTION);

    console.log(`[connect] ${MONGODB_URI}`);
    await mongoose.connect(MONGODB_URI);
    console.log(`[db] name=${mongoose.connection.name} | ok=true`);

    const cols = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    if (DEBUG) console.log("[collections]", cols);

    const typeProbe = await Coll.aggregate([{ $limit: 3 }, { $project: { t: { $type: `$${DATE_FIELD}` }, v: `$${DATE_FIELD}` } }]);
    if (DEBUG) console.log("[debug] date type:", typeProbe);

    const baseMatchPipeline = [
        {
            $addFields: {
                __dt: {
                    $switch: {
                        branches: [
                            { case: { $eq: [{ $type: `$${DATE_FIELD}` }, "date"] }, then: `$${DATE_FIELD}` },
                            { case: { $eq: [{ $type: `$${DATE_FIELD}` }, "string"] }, then: { $toDate: `$${DATE_FIELD}` } },
                            { case: { $in: [{ $type: `$${DATE_FIELD}` }, ["int", "long", "double", "decimal"]] }, then: { $toDate: `$${DATE_FIELD}` } },
                        ],
                        default: null,
                    },
                },
            },
        },
        { $match: { __dt: { $ne: null, $gte: FROM, $lt: TO } } },
    ];

    const baseCount = await Coll.aggregate([...baseMatchPipeline, { $count: "c" }]);
    const baseCnt = baseCount[0]?.c || 0;
    console.log(`[count] in range ${DATE_FIELD} coerced -> ${baseCnt}`);

    const moreFilters = [];
    if (!INCLUDE_CANCELLED) moreFilters.push({ $match: { status: { $nin: ["Cancelled", "Canceled", "Refunded"] } } });
    if (SELLER_ID) moreFilters.push({ $match: { sellerId: new mongoose.Types.ObjectId(SELLER_ID) } });
    if (SHOP_ID) moreFilters.push({ $match: { shopId: new mongoose.Types.ObjectId(SHOP_ID) } });

    const afterFilterCount = await Coll.aggregate([...baseMatchPipeline, ...moreFilters, { $count: "c" }]);
    const mCnt = afterFilterCount[0]?.c || 0;
    console.log("[count] after filters:", mCnt);

    const sample = (await Coll.aggregate([...baseMatchPipeline, ...moreFilters, { $limit: 1 }]))[0];
    if (DEBUG) console.log("[sample doc]", sample ? Object.keys(sample) : "NONE");

    const rows = await Coll.aggregate([
        ...baseMatchPipeline,
        ...moreFilters,
        { $project: { amazon_total_quantity: 1, amazon_finance_total: 1, items: 1, title: 1 } },
        { $unwind: "$items" },
        {
            $addFields: {
                _share: { $cond: [{ $gt: ["$amazon_total_quantity", 0] }, { $divide: ["$items.quantity", "$amazon_total_quantity"] }, 0] },
                _rev: { $ifNull: ["$amazon_finance_total.revenue", 0] },
                _fee: { $ifNull: ["$amazon_finance_total.fee", 0] },
                _itemTax: { $ifNull: ["$amazon_finance_total.item_tax", 0] },
                _shipTax: { $ifNull: ["$amazon_finance_total.shipping_tax", 0] },
                _discount: { $ifNull: ["$amazon_finance_total.item_promotion_discount", 0] },
                _opcost: { $ifNull: ["$amazon_finance_total.opCost", 0] },
                _cogs: { $ifNull: ["$items.cost_breakdown.base_cost_total_for_item_including_shipping", 0] },
                _pt: { $ifNull: ["$items.cost_breakdown.productTypeValue", "$items.cost_breakdown.itemDisplayName"] },
                _title: "$items.title",
                _qty: "$items.quantity",
            },
        },
        {
            $project: {
                qty: "$_qty",
                product_type: "$_pt",
                title: "$_title",
                cogs: "$_cogs",
                revenue: { $multiply: ["$_rev", "$_share"] },
                fee: { $multiply: ["$_fee", "$_share"] },
                item_tax: { $multiply: ["$_itemTax", "$_share"] },
                shipping_tax: { $multiply: ["$_shipTax", "$_share"] },
                discount: { $multiply: ["$_discount", "$_share"] },
                opcost: { $multiply: ["$_opcost", "$_share"] },
            },
        },
        {
            $addFields: {
                profit: {
                    $subtract: ["$revenue", { $add: ["$fee", "$item_tax", "$shipping_tax", "$discount", "$cogs", "$opcost"] }],
                },
            },
        },
    ]);
    console.log("[rows] after unwind+calc:", rows.length);

    const enriched = rows.map((r) => {
        const src = r.product_type || r.title;
        const { category, family } = resolveCategory(src);
        return { ...r, category, family };
    }).filter((r) => (FAMILY_FILTER ? r.family === FAMILY_FILTER : true));

    const catAgg = {};
    for (const r of enriched) {
        if (!catAgg[r.category])
            catAgg[r.category] = { units: 0, revenue: 0, cogs: 0, fee: 0, item_tax: 0, shipping_tax: 0, discount: 0, opcost: 0, profit: 0 };
        const g = catAgg[r.category];
        g.units += r.qty || 0;
        g.revenue += r.revenue || 0;
        g.cogs += r.cogs || 0;
        g.fee += r.fee || 0;
        g.item_tax += r.item_tax || 0;
        g.shipping_tax += r.shipping_tax || 0;
        g.discount += r.discount || 0;
        g.opcost += r.opcost || 0;
        g.profit += r.profit || 0;
    }

    const table = Object.entries(catAgg).map(([category, g]) => {
        const rev = g.revenue || 0.00001;
        return {
            category,
            units: g.units,
            revenue: to2(g.revenue),
            profit: to2(g.profit),
            profit_pct: to2((g.profit / rev) * 100),
            cogs_pct: to2((g.cogs / rev) * 100),
            fee_pct: to2((g.fee / rev) * 100),
            item_tax_pct: to2((g.item_tax / rev) * 100),
            shipping_tax_pct: to2((g.shipping_tax / rev) * 100),
            discount_pct: to2((g.discount / rev) * 100),
        };
    });

    const grand = Object.values(catAgg).reduce(
        (acc, g) => {
            acc.units += g.units;
            acc.revenue += g.revenue;
            acc.cogs += g.cogs;
            acc.fee += g.fee;
            acc.item_tax += g.item_tax;
            acc.shipping_tax += g.shipping_tax;
            acc.discount += g.discount;
            acc.opcost += g.opcost;
            acc.profit += g.profit;
            return acc;
        },
        { units: 0, revenue: 0, cogs: 0, fee: 0, item_tax: 0, shipping_tax: 0, discount: 0, opcost: 0, profit: 0 }
    );
    const rev = grand.revenue || 0.00001;
    const grandRow = {
        category: "TOTAL",
        units: grand.units,
        revenue: to2(grand.revenue),
        profit: to2(grand.profit),
        profit_pct: to2((grand.profit / rev) * 100),
        cogs_pct: to2((grand.cogs / rev) * 100),
        fee_pct: to2((grand.fee / rev) * 100),
        item_tax_pct: to2((grand.item_tax / rev) * 100),
        shipping_tax_pct: to2((grand.shipping_tax / rev) * 100),
        discount_pct: to2((grand.discount / rev) * 100),
    };

    console.log("\n=== % theo DANH MỤC SẢN PHẨM ===");
    console.table(
        [...table, grandRow].map((r) => ({
            "Product Category": r.category,
            "Units Sold": r.units,
            "Total Revenue ($)": r.revenue,
            "Total Profit ($)": r.profit,
            "Profit %": r.profit_pct,
            "Product Cost % (COGS)": r.cogs_pct,
            "Amazon Fee %": r.fee_pct,
            "Item Tax %": r.item_tax_pct,
            "Shipping Tax %": r.shipping_tax_pct,
            "Discount %": r.discount_pct,
        }))
    );

    if (OUT_CSV) {
        const header = [
            "Product Category",
            "Units Sold",
            "Total Revenue ($)",
            "Total Profit ($)",
            "Profit %",
            "Product Cost % (COGS)",
            "Amazon Fee %",
            "Item Tax %",
            "Shipping Tax %",
            "Discount %",
        ].join(",");
        const lines = table.map((r) =>
            [
                r.category,
                r.units,
                r.revenue,
                r.profit,
                r.profit_pct,
                r.cogs_pct,
                r.fee_pct,
                r.item_tax_pct,
                r.shipping_tax_pct,
                r.discount_pct,
            ].join(",")
        );
        lines.push(
            [
                grandRow.category,
                grandRow.units,
                grandRow.revenue,
                grandRow.profit,
                grandRow.profit_pct,
                grandRow.cogs_pct,
                grandRow.fee_pct,
                grandRow.item_tax_pct,
                grandRow.shipping_tax_pct,
                grandRow.discount_pct,
            ].join(",")
        );
        try {
            fs.writeFileSync(path.resolve(process.cwd(), OUT_CSV), [header, ...lines].join("\n"));
            console.log(`[csv] wrote ${OUT_CSV}`);
        } catch (e) {
            console.error(`[csv] Không thể ghi file (có thể đang mở trong Excel): ${OUT_CSV}`);
        }
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
