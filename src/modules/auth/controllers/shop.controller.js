const shopService = require("../services/shop.service");

class ShopController {
  async getAllShops(req, res) {
    try {
      const shops = await shopService.getAllShops(req.query);
      res.json(shops);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  }

  async getShopById(req, res) {
    try {
      const shop = await shopService.getShopById(req.params.id);
      res.json(shop);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  }

  async createShop(req, res) {
    try {
      const shop = await shopService.createShop(req.body);
      res.status(201).json(shop);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  }

  async updateShop(req, res) {
    try {
      const shop = await shopService.updateShop(req.params.id, req.body);
      res.json(shop);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  }

  async deleteShop(req, res) {
    try {
      await shopService.deleteShop(req.params.id);
      res.status(204).send();
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  }

  async addUserToShop(req, res) {
    try {
      const { shopId, userId } = req.body;
      const shop = await shopService.addUserToShop(shopId, userId);
      res.status(200).json(shop);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  }

  async updateShopStatus(req, res) {
    try {
      const { shopId, status } = req.body;
      const shop = await shopService.updateShopStatus(shopId, status);
      res.json(shop);
    } catch (e) {
      res.status(400).json({ message: e.message });
    }
  }

  async getClients(req, res) {
    try {
      const result = await shopService.getClients();
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  }

  async connectExtension(req, res) {
    try {
      const result = await shopService.connectExtension(req.body);
      res.json(result);
    } catch (e) {
      console.error("POST /ext/connect error:", e);
      res.status(500).json({ ok: false, message: e.message });
    }
  }
}

module.exports = new ShopController();

