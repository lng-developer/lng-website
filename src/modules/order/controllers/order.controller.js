const orderService = require("../services/order.service");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

class OrderController {
    /**
     * GET /orders or /fe
     */
    async getOrders(req, res) {
        try {
            const result = await orderService.getOrders(req.query, req.user);
            return res.json(result);
        } catch (error) {
            console.error("OrderController.getOrders error:", error);
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * GET /orders/stats or /statistic
     */
    async getStatistics(req, res) {
        try {
            const result = await orderService.getStatistics(req.query, req.user);
            return res.json(result);
        } catch (error) {
            console.error("OrderController.getStatistics error:", error);
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * GET /orders/:id
     */
    async getOrderById(req, res) {
        try {
            const order = await orderService.getOrderById(req.params.id);
            if (!order) return res.status(404).json({ message: "Order not found" });
            return res.json(order);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /orders/import-json
     */
    async importOrderJson(req, res) {
        try {
            const result = await orderService.importOrderJson(req.body, req.user);
            return res.json(result);
        } catch (error) {
            console.error("OrderController.importOrderJson error:", error);
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * PUT /orders/:orderId/status or /update-status
     */
    async updateStatus(req, res) {
        try {
            const orderId = req.params.orderId || req.body.orderId;
            const result = await orderService.updateStatus(orderId, req.body.status, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(400).json({ message: error.message });
        }
    }

    /**
     * PUT /update-shipping-type
     */
    async updateShippingType(req, res) {
        try {
            const { orderId, shipping_type } = req.body;
            if (!orderId || !shipping_type) {
                return res.status(400).json({ message: "Missing orderId or shipping type" });
            }
            const result = await orderService.updateShippingType(orderId, shipping_type);
            return res.json({ message: "Order shipping type updated successfully", ...result });
        } catch (error) {
            return res.status(error.message === "Order not found" ? 404 : 400).json({ message: error.message });
        }
    }

    /**
     * PUT /update-base-cost
     */
    async updateBaseCost(req, res) {
        try {
            const { orderId, base_cost } = req.body;
            if (!orderId || base_cost === undefined || base_cost === null) {
                return res.status(400).json({ message: "Missing orderId or base cost" });
            }
            const result = await orderService.updateManualBaseCost(orderId, base_cost);
            return res.json({ message: "Order base cost updated successfully", ...result });
        } catch (error) {
            return res.status(error.message === "Order not found" ? 404 : 400).json({ message: error.message });
        }
    }

    /**
     * PUT /update-customer-info
     */
    async updateCustomerInfo(req, res) {
        try {
            const { orderId, customer_infor } = req.body;
            if (!orderId) return res.status(400).json({ message: "Missing orderId" });
            const result = await orderService.updateCustomerInfo(orderId, customer_infor);
            return res.json(result);
        } catch (error) {
            return res.status(error.message === "Order not found" ? 404 : 400).json({ message: error.message });
        }
    }

    /**
     * PUT /open-case
     */
    async openCaseInOrder(req, res) {
        try {
            const { orderId, caseIds } = req.body;
            if (!orderId || !Array.isArray(caseIds)) {
                return res.status(400).json({ message: "Missing orderId or caseIds (should be an array)" });
            }
            const context = { source: "PORTAL", ip: req.ip, userAgent: req.headers["user-agent"] };
            const result = await orderService.openCaseInOrder(orderId, caseIds, req.user, context);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * PUT /remove-case
     */
    async removeCaseFromOrder(req, res) {
        try {
            const { orderId, caseIds } = req.body;
            if (!orderId || !Array.isArray(caseIds)) {
                return res.status(400).json({ message: "Missing orderId or caseIds (should be an array)" });
            }
            const context = { source: "PORTAL", ip: req.ip, userAgent: req.headers["user-agent"] };
            const result = await orderService.removeCaseFromOrder(orderId, caseIds, req.user, context);
            return res.json(result);
        } catch (error) {
            return res.status(error.message.includes("Invalid") ? 400 : 500).json({ message: error.message });
        }
    }

    /**
     * PUT /update-base-image
     */
    async updateBaseImageUrl(req, res) {
        try {
            const { orderId, orderItemId, imageUrl } = req.body;
            const result = await orderService.updateBaseImageUrl(orderId, orderItemId, imageUrl);
            return res.json({ message: "Base image URL updated successfully", ...result });
        } catch (error) {
            const status = error.message.includes("not found") ? 404 : 400;
            return res.status(status).json({ message: error.message });
        }
    }

    /**
     * POST /orders/:orderId/tracking or PUT /:orderId/items/:orderItemId/tracking
     */
    async updateItemTracking(req, res) {
        try {
            const orderId = req.params.orderId || req.body.orderId;
            const result = await orderService.updateItemTracking(orderId, req.body, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(400).json({ message: error.message });
        }
    }

    /**
     * POST /orders/:orderId/replace
     */
    async createReplacementOrder(req, res) {
        try {
            const orderId = req.params.orderId || req.body.orderId;
            const result = await orderService.createReplacementOrder(orderId, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /orders/:orderId/compute-cost or /compute-base-cost
     */
    async computeBaseCost(req, res) {
        try {
            const orderId = req.params.orderId || req.body.orderId;
            if (!orderId) return res.status(400).json({ message: "Missing orderId" });
            const result = await orderService.computeBaseCost(orderId, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /compute-base-cost/batch
     */
    async computeBaseCostForMany(req, res) {
        try {
            const result = await orderService.computeBaseCostForMany(req.body.limit);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /orders/:orderId/address/validate
     */
    async validateAddressByOrderId(req, res) {
        try {
            const orderId = req.params.orderId || req.body.orderId;
            const result = await orderService.validateAddressByOrderId(orderId);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /orders/address/validate-batch
     */
    async validateInvalidAddressesBatch(req, res) {
        try {
            const result = await orderService.validateInvalidAddressesBatch(req.query);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /update-from-xlsx
     */
    async updateFromXlsx(req, res) {
        try {
            const result = await orderService.updateFromXlsx(req.file, req.body, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * PUT /:orderId (scale update)
     */
    async updateScaleOrder(req, res) {
        try {
            const result = await orderService.updateScaleOrder(req.params.orderId, req.body);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /update-tracking
     */
    async updateTrackingByOrderId(req, res) {
        try {
            const { orderId, tracking } = req.body;
            if (!orderId) return res.status(400).json({ message: "orderId is required" });
            if (tracking === undefined || tracking === null) {
                return res.status(400).json({ message: "tracking is required" });
            }
            const result = await orderService.updateTrackingByOrderId(orderId, tracking);
            return res.json({ message: "Tracking updated for all items", ...result });
        } catch (error) {
            return res.status(error.message === "Order not found" ? 404 : 500).json({ message: error.message });
        }
    }
}

const controller = new OrderController();
// Expose upload middleware for routes that need it
controller.upload = upload;

module.exports = controller;
