// src/models/index.js
const mongoose = require("mongoose");
const User = require("./user.model");
const Role = require("./role.model");
const Account = require("./account.model");
const OrderCustomProduct = require("./orderCustomProduct.model");
const Shop = require("./shop.model");
const Vendor = require("./vendor.model");
const VendorProduct = require("./vendorProduct.model");
const VendorCostCenter = require("./vendorCostCenter.model");
const Case = require("./case.model");
const Listing = require("./listing.model");
const ProductTypeGroup = require("./productTypeGroup.model");
const ConfigCostCenter = require("./configCostCenter.model");
const ConfigOptionMapping = require("./configOptionMapping");
const Report = require("./report.model");
const Ads = require("./ads.model");
const SkuMappingConfig = require("./skuMappingConfig.model")
const SkuMappingEntry = require("./skuMappingEntry.model")

// Cau hinh mongoose dang global
mongoose.Promise = global.Promise;
// Dinh nghia doi tuong DB
const db = {};
db.mongoose = mongoose;

// Bo sung cac thuoc tinh cho DB
db.user = User;
db.role = Role;
db.account = Account;
db.orderCustomProduct = OrderCustomProduct;
db.shop = Shop;
db.vendor = Vendor;
db.vendorProduct = VendorProduct;
db.vendorCostCenter = VendorCostCenter;
db.case = Case;
db.listing = Listing;
db.productTypeGroup = ProductTypeGroup;
db.configCostCenter = ConfigCostCenter;
db.configOptionMapping = ConfigOptionMapping;
db.Report = Report;
db.Ads = Ads;
db.SkuMappingConfig = SkuMappingConfig
db.SkuMappingEntry = SkuMappingEntry
db.connectDB = async () => {
  await mongoose
    .connect(process.env.MONGO_URI, {
      dbName: process.env.DB_NAME,
    })
    .then(() => console.log("Connect to MongoDB success"))
    .catch((error) => {
      console.error(error.message);
      process.exit();
    });
};

module.exports = db;
