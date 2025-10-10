const db = require("../models");
const Shop = db.shop;
const User = db.user;
const RealtimeLog = db.RealtimeLog;

const getAllShops = async (req, res) => {
  const shops = await Shop.find().populate("userIds");
  res.json(shops);
};

const getShopById = async (req, res) => {
  const shop = await Shop.findById(req.params.id).populate("userIds");
  res.json(shop);
};

const createShop = async (req, res) => {
  const shop = await Shop.create(req.body);
  res.status(201).json(shop);
};

const updateShop = async (req, res) => {
  const shop = await Shop.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });
  res.json(shop);
};

const deleteShop = async (req, res) => {
  await Shop.findByIdAndDelete(req.params.id);
  res.status(204).send();
};

const addUserToShop = async (req, res) => {
  const { shopId, userId } = req.body;
  const shop = await Shop.findById(shopId);
  if (!shop.userIds.includes(userId)) {
    shop.userIds.push(userId);
    await shop.save();
  }
  res.status(200).json(shop);
};

const updateShopStatus = async (req, res) => {
  const { shopId, status } = req.body;
  const allowed = ["Active", "Inactive"];
  if (!allowed.includes(status))
    return res.status(400).json({ message: "Invalid status" });
  const shop = await Shop.findByIdAndUpdate(shopId, { status }, { new: true });
  res.json(shop);
};

const getClients = async (_req, res) => {
  try {
    // lấy cả _id để làm key hiển thị
    const shops = await Shop.find(
      {},
      { _id: 1, store: 1, name: 1, clients: 1 }
    ).lean();
    const out = [];

    for (const s of shops) {
      const list = Array.isArray(s.clients) ? s.clients : [];
      list.forEach((c, idx) => {
        out.push({
          // trước đây có socketId/clientId; giờ không có nữa
          socketId: null,
          clientId: null, // giữ field cho FE cũ nếu cần
          label: c.label || `${s.name || s.store || s._id}`,
          version: c.version || "",
          ua: "",
          ip: "",
          // tạo một id ổn định để FE dùng làm key
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

    // sắp xếp theo lastSeen giảm dần
    out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
};

const connectExtension = async (req, res) => {
  try {
    const { shopId, label, version } = req.body || {};
    if (!shopId) {
      return res.status(400).json({ ok: false, message: "shopId required" });
    }

    // 1) Tìm shop theo _id
    const shop = await Shop.findOne(
      { _id: shopId },
      { _id: 1, name: 1, store: 1 }
    ).lean();
    if (!shop)
      return res.status(404).json({ ok: false, message: "Shop not found" });

    // 2) Chỉ PUSH thêm 1 phần tử clients (không check trùng, theo yêu cầu)
    const now = new Date();
    await Shop.updateOne(
      { _id: shopId },
      {
        $push: {
          clients: {
            // KHÔNG có clientId nữa
            label: label || shop.name || shop.store || String(shopId),
            version: version || "",
            status: "online",
            firstSeen: now,
            lastSeen: now,
          },
        },
      }
    );

    // 3) (Tuỳ chọn) log nhẹ
    try {
      await RealtimeLog.create({
        ts: Date.now(),
        type: "CONNECT",
        day: now.toISOString().slice(0, 10),
        clientId: null,
        label: label || null,
        meta: { shopId, version: version || "" },
      });
    } catch (_) {}

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /ext/connect error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
};

module.exports = {
  getAllShops,
  getShopById,
  createShop,
  updateShop,
  deleteShop,
  addUserToShop,
  updateShopStatus,
  getClients,
  connectExtension,
};
