require("dotenv").config();

const db = require("../src/models");

const BAD_URL_PATTERNS = [
    /\/legal\//i,
    /\/cookies/i,
    /\/privacy/i,
    /help\.etsy\.com/i,
    /\/ac\/evergreenVendor\//i,
    /\.js($|\?)/i,
    /\.css($|\?)/i,
];

function parseArgs() {
    return {
        dryRun: process.argv.includes("--dry-run"),
    };
}

function isFalsePositiveCustomFile(file = {}) {
    if (file.source !== "etsy_order_detail_html") return false;
    if (file.storageUrl) return false;
    const downloadUrl = String(file.downloadUrl || "");
    const previewUrl = String(file.previewUrl || "");
    const fileName = String(file.fileName || "");
    const haystack = `${downloadUrl} ${previewUrl} ${fileName}`;
    return BAD_URL_PATTERNS.some((pattern) => pattern.test(haystack));
}

async function main() {
    const { dryRun } = parseArgs();
    const summary = {
        dryRun,
        scannedOrders: 0,
        modifiedOrders: 0,
        removedFiles: 0,
    };

    await db.connectDB();

    const cursor = db.EtsyOrder.find({
        "items.customFiles.source": "etsy_order_detail_html",
    })
        .select({ orderId: 1, items: 1 })
        .cursor();

    for await (const order of cursor) {
        summary.scannedOrders += 1;
        let removedForOrder = 0;

        for (const item of order.items || []) {
            if (!Array.isArray(item.customFiles) || item.customFiles.length === 0) continue;
            const before = item.customFiles.length;
            item.customFiles = item.customFiles.filter((file) => !isFalsePositiveCustomFile(file));
            removedForOrder += before - item.customFiles.length;
        }

        if (removedForOrder > 0) {
            summary.modifiedOrders += 1;
            summary.removedFiles += removedForOrder;
            if (!dryRun) {
                order.markModified("items");
                await order.save();
            }
        }
    }

    console.log("[ETSY_CUSTOM_FILE_FALSE_POSITIVE_CLEANUP]", summary);
    await db.mongoose.disconnect();
}

main().catch(async (err) => {
    console.error("[ETSY_CUSTOM_FILE_FALSE_POSITIVE_CLEANUP] failed", err);
    try {
        await db.mongoose.disconnect();
    } catch (_) {
        // ignore disconnect errors
    }
    process.exit(1);
});
