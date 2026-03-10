const db = require("../../../models");
const Order = db.orderCustomProduct;
const Listing = db.listing;
const VendorProduct = db.vendorProduct;
const Shop = db.shop;
const cloudinary = require("../../../utils/cloudinary");
const FulfillmentService = require("./fulfillment.service");
const { addPointsFromTask, addPenaltyForScaleReject } = require("../../system/services/points.service");
const TaskType = require("../../task/constants/taskType");
const mongoose = require("mongoose");

class ScaleService {
    computeOverallScaleStatus(orderDoc) {
        const items = orderDoc.items || [];
        if (items.length === 0) return "Need Scale";
        const statuses = items.map((i) => String(i?.scale_status || "Need Scale"));
        if (statuses.some((s) => s === "QC Rejected")) return "QC Rejected";
        if (statuses.every((s) => s === "Complete")) return "Ready";
        if (statuses.every((s) => s === "Pending" || s === "Complete")) return "Pending";
        return "Need Scale";
    }

    async uploadFulfillmentFiles(orderId, orderItemId, files, positions, user) {
        const order = await Order.findOne({ orderId });
        if (!order) throw new Error("Order not found");
        const item = order.items.find((i) => i.orderItemId === orderItemId);
        if (!item) throw new Error("Order item not found");

        if (!item.fulfillment_file || !(item.fulfillment_file instanceof Map)) {
            item.fulfillment_file = new Map(Object.entries(item.fulfillment_file || {}));
        }

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const pos = String(positions[i]?.position || "").trim().toLowerCase();
            if (!pos) throw new Error(`Missing position for file index ${i}`);
            const public_id = `fulfillment_files/${orderId}-${orderItemId}-${pos}`;
            const up = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream({ resource_type: "image", overwrite: true, public_id }, (err, result) => (err ? reject(err) : resolve(result)));
                stream.end(file.buffer);
            });
            item.fulfillment_file.set(pos, up.secure_url);
        }

        item.scale_status = "Pending";
        order.scale_overall_status = this.computeOverallScaleStatus(order);
        item.markModified("fulfillment_file");
        order.scaleId = user.id || user._id;
        await order.save();
        return { item_scale_status: item.scale_status, order_scale_overall_status: order.scale_overall_status, fulfillment_file: Object.fromEntries(item.fulfillment_file) };
    }

    async confirmScale(orderId, orderItemId, decision, note, provider, user) {
        const order = await Order.findOne({ orderId });
        if (!order) throw new Error("Order not found");
        const item = order.items.find((i) => i.orderItemId === orderItemId);
        if (!item) throw new Error("Order item not found");

        if (decision === "reject") {
            item.scale_status = "QC Rejected";
            item.fulfillment_file = new Map();
            if (note) item.qc_note = note;
            order.scale_overall_status = "QC Rejected";

            const listing = await Listing.findOne({ asin: item.asin }).select("asin_type").lean();
            if (order.scaleId) {
                await addPenaltyForScaleReject({ userId: order.scaleId, orderId, orderItemId, asinType: listing?.asin_type || "Normal", note: note || "QC Rejected" });
            }
            await order.save();
            return { status: "rejected", item_scale_status: item.scale_status, order_scale_overall_status: order.scale_overall_status };
        }

        // Approve
        const hasFF = item.fulfillment_file && (item.fulfillment_file instanceof Map ? item.fulfillment_file.size > 0 : Object.keys(item.fulfillment_file).length > 0);
        if (!hasFF && !item.svgFile) throw new Error("Missing print files");

        item.scale_status = "Complete";
        if (note) item.qc_note = note;
        order.scale_overall_status = this.computeOverallScaleStatus(order);

        if (order.scale_overall_status === "Ready") {
            const listing = await Listing.findOne({ asin: item.asin }).select("asin_type").lean();
            await addPointsFromTask({ userId: order.scaleId, taskId: orderId, type: TaskType.ScaleTask, difficulty: listing?.asin_type || "Normal", quantity: order.items.length });

            if (order.address_validation?.isValid === false) {
                order.scale_overall_status = "Address Invalid";
                await order.save();
                throw new Error("Invalid address detected");
            }

            const result = await FulfillmentService.send(order, provider);
            return { status: "ready_and_sent", vendorKey: result.vendorKey, alreadySent: result.alreadySent };
        }

        await order.save();
        return { status: "approved_item", item_scale_status: item.scale_status, order_scale_overall_status: order.scale_overall_status };
    }
}

module.exports = new ScaleService();

