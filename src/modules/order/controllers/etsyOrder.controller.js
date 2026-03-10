const etsyOrderService = require("../services/etsyOrder.service");

class EtsyOrderController {
    async importOrders(req, res) {
        try {
            const stats = await etsyOrderService.importOrders(req.files || [], req.body.shopId);
            return res.json({ message: "Etsy Order import completed (multi-shop + seller preserved)", stats });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    async getListOrders(req, res) {
        try {
            const result = await etsyOrderService.getListOrders(req.query);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    async deleteOrder(req, res) {
        try {
            await etsyOrderService.deleteOrder(req.params.id);
            return res.status(204).send();
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
}

module.exports = new EtsyOrderController();
