const orderService = require("../services/order.service");

class OrderController {
    /**
     * GET /orders
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
     * GET /orders/stats
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
     * PUT /orders/:orderId/status
     */
    async updateStatus(req, res) {
        try {
            const result = await orderService.updateStatus(req.params.orderId, req.body.status, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(400).json({ message: error.message });
        }
    }

    /**
     * POST /orders/:orderId/tracking
     */
    async updateItemTracking(req, res) {
        try {
            const result = await orderService.updateItemTracking(req.params.orderId, req.body, req.user);
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
            const result = await orderService.createReplacementOrder(req.params.orderId, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }

    /**
     * POST /orders/:orderId/compute-cost
     */
    async computeBaseCost(req, res) {
        try {
            const result = await orderService.computeBaseCost(req.params.orderId, req.user);
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
            const result = await orderService.validateAddressByOrderId(req.params.orderId);
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
     * POST /orders/import-xlsx
     */
    async updateFromXlsx(req, res) {
        try {
            const result = await orderService.updateFromXlsx(req.file, req.body, req.user);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ message: error.message });
        }
    }
}

module.exports = new OrderController();

