const Shop = require("../models/shop.model");
const RealtimeLog = require("../../system/models/realtimeLog.model");

class ShopService {
    async getAllShops(query) {
        const { merchant } = query;
        const filter = {};
        if (merchant) filter.merchant = new RegExp(merchant, "i");
        return await Shop.find(filter).populate("userIds");
    }

    async getShopById(id) {
        return await Shop.findById(id).populate("userIds");
    }

    async createShop(data) {
        return await Shop.create(data);
    }

    async updateShop(id, data) {
        return await Shop.findByIdAndUpdate(id, data, { new: true });
    }

    async deleteShop(id) {
        return await Shop.findByIdAndDelete(id);
    }

    async addUserToShop(shopId, userId) {
        const shop = await Shop.findById(shopId);
        if (!shop) throw new Error("Shop not found");
        if (!shop.userIds.includes(userId)) {
            shop.userIds.push(userId);
            await shop.save();
        }
        return shop;
    }

    async updateShopStatus(shopId, status) {
        const allowed = ["Active", "Inactive"];
        if (!allowed.includes(status)) throw new Error("Invalid status");
        return await Shop.findByIdAndUpdate(shopId, { status }, { new: true });
    }

    async getClients() {
        const shops = await Shop.find({}, { _id: 1, store: 1, name: 1, clients: 1 }).lean();
        const out = [];

        for (const s of shops) {
            const list = Array.isArray(s.clients) ? s.clients : [];
            list.forEach((c, idx) => {
                out.push({
                    socketId: null,
                    clientId: null,
                    label: c.label || `${s.name || s.store || s._id}`,
                    version: c.version || "",
                    ua: "",
                    ip: "",
                    shopName: s.name,
                    id: `${String(s._id)}:${idx}`,
                    connectedAt: c.firstSeen ? new Date(c.firstSeen).getTime() : 0,
                    lastSeen: c.lastSeen ? new Date(c.lastSeen).getTime() : 0,
                    statusSummary: {
                        overall: c.status === "online" ? "success" : "idle",
                        lastJobId: null,
                        lastTs: c.lastSeen ? new Date(c.lastSeen).getTime() : 0,
                        phases: {},
                        onlineForSec: 0,
                        idleForSec: 0,
                    },
                });
            });
        }

        out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return out;
    }

    async connectExtension({ shopId, label, version }) {
        if (!shopId) throw new Error("shopId required");

        const shop = await Shop.findOne({ _id: shopId }, { _id: 1, name: 1, store: 1 }).lean();
        if (!shop) throw new Error("Shop not found");

        const now = new Date();
        const existed = await Shop.exists({ _id: shopId, "clients.shopId": shopId });

        if (existed) {
            await Shop.updateOne(
                { _id: shopId, "clients.shopId": shopId },
                {
                    $set: {
                        "clients.$.lastSeen": now,
                        "clients.$.status": "online",
                        ...(version ? { "clients.$.version": version } : {}),
                        ...(label ? { "clients.$.label": label } : {}),
                    },
                }
            );
        } else {
            await Shop.updateOne(
                { _id: shopId },
                {
                    $push: {
                        clients: {
                            shopId,
                            label: label || shop.name || shop.store || String(shopId),
                            version: version || "",
                            status: "online",
                            firstSeen: now,
                            lastSeen: now,
                        },
                    },
                }
            );
        }

        try {
            await RealtimeLog.create({
                ts: Date.now(),
                type: existed ? "CONNECT_UPDATE" : "CONNECT_CREATE",
                day: now.toISOString().slice(0, 10),
                clientId: null,
                label: label || null,
                meta: { shopId, version: version || "" },
            });
        } catch (_) {
            // Ignore log error
        }

        return { ok: true };
    }
}

module.exports = new ShopService();

