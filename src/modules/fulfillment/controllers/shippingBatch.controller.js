const shippingBatchService = require("../services/shippingBatch.service");

class ShippingBatchController {
    async createBatchFromFile(req, res, next) {
        try {
            const { machineId, label } = req.body;
            const file = req.file;

            if (!file) {
                return res.status(400).json({ message: "Missing file TXT (field: file)" });
            }
            if (!machineId || !label) {
                return res.status(400).json({ message: "machineId and label are required" });
            }

            const { batch, confirmFileContent } = await shippingBatchService.createBatchFromFile(machineId, label, file.buffer);

            return res.status(201).json({
                batchId: batch._id,
                machineId: batch.machineId,
                label: batch.label,
                status: batch.status,
                fileName: batch.fileName,
                stats: batch.stats,
                confirmFileContent,
            });
        } catch (err) {
            if (err.message.includes("No valid rows") || err.message.includes("Không tìm thấy") || err.message.includes("No orderId")) {
                return res.status(400).json({ message: err.message });
            }
            next(err);
        }
    }

    async listShippingBatches(req, res, next) {
        try {
            const filters = req.query;
            const response = await shippingBatchService.listBatches(filters);
            return res.json({ total: response.length, batches: response });
        } catch (err) {
            next(err);
        }
    }

    async createUpdateBatchFromSystem(req, res, next) {
        try {
            const { batchId } = req.params;
            const result = await shippingBatchService.createUpdateBatchFromSystem(batchId);

            if (!result.updateBatchCreated) {
                return res.status(200).json({
                    message: "No real tracking found for fake orders in this batch",
                    updateBatchCreated: false,
                    originalBatchId: result.originalBatchId,
                    remainingFakeCount: result.remainingFakeCount,
                });
            }

            return res.status(201).json({
                updateBatchCreated: true,
                updateBatchId: result.updateBatch._id,
                originalBatchId: result.originalBatchId,
                machineId: result.updateBatch.machineId,
                label: result.updateBatch.label,
                status: result.updateBatch.status,
                fileName: result.updateBatch.fileName,
                stats: result.updateBatch.stats,
                updateFileContent: result.updateFileContent,
                remainingFakeCount: result.remainingFakeCount,
            });
        } catch (err) {
            if (err.message === "Original batch not found") return res.status(404).json({ message: err.message });
            if (err.message === "No fake tracking to update in this batch") return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async downloadCompletedFile(req, res, next) {
        try {
            const { batchId } = req.params;
            const { filename, fileContent } = await shippingBatchService.getCompletedFileData(batchId, req.query);

            res.status(200)
                .set("Content-Type", "text/tab-separated-values; charset=utf-8")
                .set("Content-Disposition", `attachment; filename="${filename}"`)
                .send(fileContent);
        } catch (err) {
            if (err.message === "Batch not found") return res.status(404).json({ message: err.message });
            if (err.message.includes("No completed data") || err.message.includes("invalid date")) return res.status(400).json({ message: err.message });
            next(err);
        }
    }

    async updateAllFakeTracking(req, res, next) {
        try {
            const { machineId } = req.body;
            if (!machineId) return res.status(400).json({ message: "machineId is required" });

            const result = await shippingBatchService.updateAllFakeTracking(machineId);
            if (result.message) return res.status(200).json(result);
            return res.status(201).json(result);
        } catch (err) {
            next(err);
        }
    }

    async downloadAllUpdatedFakeFile(req, res, next) {
        try {
            const { machineId, batchId } = req.query;
            const { filename, content } = await shippingBatchService.getAllUpdatedFakeFileData(machineId, batchId, req.query);

            return res.status(200)
                .set("Content-Type", "text/tab-separated-values; charset=utf-8")
                .set("Content-Disposition", `attachment; filename="${filename}"`)
                .send(content);
        } catch (err) {
            if (err.message.includes("not found")) return res.status(404).json({ message: err.message });
            if (err.message.includes("No data") || err.message.includes("No valid rows") || err.message.includes("No matching")) return res.status(400).json({ message: err.message });
            next(err);
        }
    }
}

module.exports = new ShippingBatchController();

