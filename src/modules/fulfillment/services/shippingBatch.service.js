// src/modules/fulfillment/services/shippingBatch.service.js
const ShippingBatch = require("../models/shippingBatch.model");
const OrderCustomProduct = require("../../order/models/order.model");

async function getRealTrackingForOrder(orderId) {
    const order = await OrderCustomProduct.findOne({ orderId: orderId });
    return order?.items[0]?.tracking_info?.tracking || null;
}

function generateFakeTracking() {
    let tracking = "92";
    for (let i = 0; i < 18; i++) {
        tracking += Math.floor(Math.random() * 10);
    }
    return tracking;
}

function buildPlainTextFile(rows) {
    let content = "orderId|tracking\n";
    for (const row of rows) {
        content += `${row.orderId}|${row.tracking}\n`;
    }
    return content;
}

function parseOrdersWithDaysFromTxt(fileBuffer) {
    const raw = fileBuffer.toString("utf8");
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return [];

    const headerLine = lines[0];
    const delimiter = "\t";

    const headers = headerLine.split(delimiter).map((h) => h.trim().toLowerCase());
    const orderIdIndex = headers.findIndex((h) => h === "order-id" || h === '"order-id"');
    const daysPastPromiseIndex = headers.findIndex((h) => h === "days-past-promise" || h === '"days-past-promise"');

    if (orderIdIndex === -1) throw new Error("Không tìm thấy cột 'order-id' trong file TXT");
    if (daysPastPromiseIndex === -1) throw new Error("Không tìm thấy cột 'days-past-promise' trong file TXT");

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const cols = line.split(delimiter);
        const orderId = (cols[orderIdIndex] || "").trim();
        const daysStr = (cols[daysPastPromiseIndex] || "").trim();
        if (!orderId) continue;
        const daysPastPromise = Number(daysStr);
        rows.push({ orderId, daysPastPromise });
    }
    return rows;
}

function buildShipDateString(baseDate) {
    const ref = baseDate ? new Date(baseDate) : new Date();
    const shipDate = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 22, 22));
    return shipDate.toISOString().replace(".000Z", "+00:00");
}

function normalizeField(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim().replace(/^"+|"+$/g, "").replace(/,+$/g, "");
}

function buildCompletedShippingFile(completed, options = {}) {
    const { carrierCode = "USPS", shipMethod = "USPS First Class", shipDate } = options;
    let content = "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";

    for (const item of completed) {
        if (!item.orderId || !item.tracking) continue;
        const orderId = normalizeField(item.orderId);
        const tracking = normalizeField(item.tracking);
        if (!orderId || !tracking) continue;

        let finalCarrierCode = carrierCode;
        let finalShipMethod = shipMethod;

        if (tracking.startsWith("UK")) {
            finalCarrierCode = "Yanwen";
            finalShipMethod = "Yanwen Air Economy Mail General";
        }
        if (tracking.startsWith("YT")) {
            finalCarrierCode = "Yun Express";
            finalShipMethod = "YunExpress Global Direct line (standard )-Tracked";
        }

        content += [orderId, shipDate, finalCarrierCode, tracking, finalShipMethod].join("\t");
        content += "\n";
    }
    return content;
}

class ShippingBatchService {
    async createBatchFromFile(machineId, label, fileBuffer) {
        const rows = parseOrdersWithDaysFromTxt(fileBuffer);
        if (!rows.length) throw new Error("No valid rows found in file");

        const orderIds = [];
        const seen = new Set();
        for (const row of rows) {
            if (row.daysPastPromise !== -2) continue;
            const id = row.orderId;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            orderIds.push(id);
        }
        if (!orderIds.length) throw new Error("No orderId with days-past-promise = -2 found in file");

        const completed = [];
        const tracking_fakes = [];

        for (const orderId of orderIds) {
            const realTracking = await getRealTrackingForOrder(orderId);
            if (realTracking) {
                completed.push({ orderId, tracking: realTracking, isFake: false, source: "system" });
            } else {
                const fake = generateFakeTracking();
                completed.push({ orderId, tracking: fake, isFake: true, source: "fake" });
                tracking_fakes.push({ orderId, tracking: fake });
            }
        }

        const stats = {
            totalOrders: completed.length,
            totalFake: completed.filter((r) => r.isFake).length,
            totalReal: completed.filter((r) => !r.isFake).length,
        };

        const fileName = `confirm_${machineId}_${Date.now()}.txt`;
        const batch = await ShippingBatch.create({
            machineId, label, type: "CONFIRM", fileName,
            status: "CONFIRM_FILE_READY", completed, tracking_fakes, stats,
        });

        const rowsForFile = completed.map((r) => ({ orderId: r.orderId, tracking: r.tracking }));
        const confirmFileContent = buildPlainTextFile(rowsForFile);

        return { batch, confirmFileContent };
    }

    async listBatches(filters) {
        const { machineId, label, status, fromDate, toDate, limit = 50 } = filters;
        const query = {};
        if (machineId) query.machineId = machineId;
        if (label) query.label = label;
        if (status) query.status = status;
        if (fromDate || toDate) {
            query.createdAt = {};
            if (fromDate) {
                const from = new Date(fromDate);
                if (!isNaN(from.getTime())) query.createdAt.$gte = from;
            }
            if (toDate) {
                const to = new Date(toDate);
                if (!isNaN(to.getTime())) query.createdAt.$lte = to;
            }
        }

        const batches = await ShippingBatch.find(query)
            .sort({ createdAt: -1 })
            .limit(Number(limit));

        return batches.map((b) => ({
            batchId: b._id, machineId: b.machineId, label: b.label,
            status: b.status, createdAt: b.createdAt, fileName: b.fileName,
            stats: b.stats, completed: b.completed, tracking_fakes: b.tracking_fakes,
            type: b.type, confirmShipDate: b.confirmShipDate || "",
        }));
    }

    async createUpdateBatchFromSystem(batchId) {
        const original = await ShippingBatch.findById(batchId);
        if (!original) throw new Error("Original batch not found");
        if (!original.tracking_fakes || original.tracking_fakes.length === 0) {
            throw new Error("No fake tracking to update in this batch");
        }

        const resolvedItems = [];
        const remainingFakes = [];

        for (const fakeItem of original.tracking_fakes) {
            const { orderId } = fakeItem;
            const realTracking = await getRealTrackingForOrder(orderId);

            if (realTracking) {
                resolvedItems.push({ orderId, tracking: realTracking, isFake: false, source: "system" });
                const comp = original.completed.find((c) => c.orderId === orderId);
                if (comp) {
                    comp.tracking = realTracking;
                    comp.isFake = false;
                    comp.source = "system";
                }
            } else {
                remainingFakes.push(fakeItem);
            }
        }

        if (resolvedItems.length === 0) {
            return { updateBatchCreated: false, originalBatchId: original._id, remainingFakeCount: original.tracking_fakes.length };
        }

        original.tracking_fakes = remainingFakes;
        original.stats.totalOrders = original.completed.length;
        original.stats.totalFake = original.completed.filter((c) => c.isFake).length;
        original.stats.totalReal = original.completed.filter((c) => !c.isFake).length;
        await original.save();

        const updateFileName = `update_${original.machineId}_${Date.now()}.txt`;
        const updateBatch = await ShippingBatch.create({
            machineId: original.machineId, label: original.label, confirmShipDate: original.createdAt,
            type: "UPDATE_FAKE", fileName: updateFileName, status: "CONFIRM_FILE_READY",
            completed: resolvedItems, tracking_fakes: [],
            stats: { totalOrders: resolvedItems.length, totalFake: 0, totalReal: resolvedItems.length },
        });

        const rows = resolvedItems.map((r) => ({ orderId: r.orderId, tracking: r.tracking }));
        const updateFileContent = buildPlainTextFile(rows);

        return { updateBatchCreated: true, originalBatchId: original._id, updateBatch, updateFileContent, remainingFakeCount: remainingFakes.length };
    }

    async getCompletedFileData(batchId, queryOpts) {
        const { carrierCode, shipMethod, shipDate } = queryOpts;
        const batch = await ShippingBatch.findById(batchId);
        if (!batch) throw new Error("Batch not found");
        if (!batch.completed || batch.completed.length === 0) throw new Error("No completed data to export for this batch");

        let shipDateBase;
        if (shipDate) {
            const d = new Date(shipDate);
            if (isNaN(d.getTime())) throw new Error("shipDate is invalid date format");
            shipDateBase = d;
        } else {
            shipDateBase = batch.createdAt ? new Date(batch.createdAt) : new Date();
        }

        const shipDateStr = buildShipDateString(shipDateBase);
        const fileContent = buildCompletedShippingFile(batch.completed, { carrierCode, shipMethod, shipDate: shipDateStr });

        const filename = batch.fileName || (batch.type === "UPDATE_FAKE" ? `update_confirmShip_${batch._id}.txt` : `confirmShip_${batch._id}.txt`);
        return { filename, fileContent };
    }

    async updateAllFakeTracking(machineId) {
        const confirmBatches = await ShippingBatch.find({
            type: "CONFIRM", machineId, tracking_fakes: { $exists: true, $ne: [] },
        });

        if (!confirmBatches.length) return { message: "No fake tracking found in confirm batches" };

        const resolvedItems = [];
        for (const batch of confirmBatches) {
            const remainingFakes = [];
            for (const fakeItem of batch.tracking_fakes) {
                const orderId = fakeItem.orderId;
                const realTracking = await getRealTrackingForOrder(orderId);

                if (realTracking) {
                    resolvedItems.push({ orderId, tracking: realTracking, sourceConfirmBatchId: batch._id });
                    const comp = batch.completed.find((c) => c.orderId === orderId);
                    if (comp) {
                        comp.tracking = realTracking;
                        comp.isFake = false;
                        comp.source = "system";
                    }
                } else {
                    remainingFakes.push(fakeItem);
                }
            }
            batch.tracking_fakes = remainingFakes;
            batch.stats.totalFake = remainingFakes.length;
            batch.stats.totalReal = batch.completed.length - remainingFakes.length;
            await batch.save();
        }

        if (!resolvedItems.length) return { message: "No fake orders have real tracking yet" };

        const updateBatch = await ShippingBatch.create({
            machineId, type: "UPDATE_GLOBAL", status: "CONFIRM_FILE_READY",
            completed: resolvedItems, tracking_fakes: [],
            stats: { totalOrders: resolvedItems.length, totalFake: 0, totalReal: resolvedItems.length },
        });

        return { updateBatchId: updateBatch._id, totalUpdatedOrders: resolvedItems.length };
    }

    async getAllUpdatedFakeFileData(machineId, batchId, queryOpts) {
        const { carrierCode = "USPS", shipMethod = "USPS First Class" } = queryOpts;
        const updateBatch = await ShippingBatch.findById(batchId).lean();
        if (!updateBatch || updateBatch.type !== "UPDATE_GLOBAL") throw new Error("UPDATE_GLOBAL batch not found");
        if (!updateBatch.completed || updateBatch.completed.length === 0) throw new Error("No data in UPDATE_GLOBAL batch");

        const orderIds = [...new Set(updateBatch.completed.map((i) => String(i.orderId)))];
        const confirmMatches = await ShippingBatch.aggregate([
            { $match: { type: "CONFIRM", machineId, "completed.orderId": { $in: orderIds } } },
            { $unwind: "$completed" },
            { $match: { "completed.orderId": { $in: orderIds } } },
            { $group: { _id: "$completed.orderId", confirmCreatedAt: { $first: "$createdAt" } } },
        ]);

        if (!confirmMatches.length) throw new Error("No matching CONFIRM batch found for orders");

        const confirmDateMap = new Map();
        for (const row of confirmMatches) {
            confirmDateMap.set(String(row._id), buildShipDateString(row.confirmCreatedAt));
        }

        let content = "order-id\tship-date\tcarrier-code\ttracking-number\tship-method\n";
        let total = 0;

        for (const item of updateBatch.completed) {
            const orderId = String(item.orderId).trim();
            const tracking = String(item.tracking || "").trim();
            const shipDate = confirmDateMap.get(orderId);
            if (!shipDate || !tracking) continue;

            let finalCarrierCode = carrierCode;
            let finalShipMethod = shipMethod;
            if (tracking.startsWith("UK")) { finalCarrierCode = "Yanwen"; finalShipMethod = "Yanwen Air Economy Mail General"; }
            if (tracking.startsWith("YT")) { finalCarrierCode = "Yun Express"; finalShipMethod = "YunExpress Global Direct Line"; }

            content += [orderId, shipDate, finalCarrierCode, tracking, finalShipMethod].join("\t") + "\n";
            total++;
        }

        if (total === 0) throw new Error("No valid rows to export after mapping confirm dates");
        return { filename: `update_all_fake_${batchId}.txt`, content };
    }
}

module.exports = new ShippingBatchService();

