const db = require('../models');
const Shop = db.shop;
const User = db.user;

const getAllShops = async (req, res) => {
    const shops = await Shop.find().populate('userIds');
    res.json(shops);
};

const getShopById = async (req, res) => {
    const shop = await Shop.findById(req.params.id).populate('userIds');
    res.json(shop);
};

const createShop = async (req, res) => {
    const shop = await Shop.create(req.body);
    res.status(201).json(shop);
};

const updateShop = async (req, res) => {
    const shop = await Shop.findByIdAndUpdate(req.params.id, req.body, { new: true });
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
    const allowed = ['Active', 'Inactive'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Invalid status' });
    const shop = await Shop.findByIdAndUpdate(shopId, { status }, { new: true });
    res.json(shop);
};

module.exports = {
    getAllShops,
    getShopById,
    createShop,
    updateShop,
    deleteShop,
    addUserToShop,
    updateShopStatus
};