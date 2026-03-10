// src/models/index.js
const mongoose = require("mongoose");
const User = require("../modules/auth/models/user.model.js");
const Role = require("../modules/auth/models/role.model.js");
const Account = require("../modules/auth/models/account.model.js");
const OrderCustomProduct = require("../modules/order/models/order.model.js");
const Shop = require("../modules/auth/models/shop.model.js");
const Vendor = require("../modules/vendor/models/vendor.model.js");
const VendorProduct = require("../modules/vendor/models/vendorProduct.model.js");
const VendorCostCenter = require("../modules/vendor/models/vendorCostCenter.model.js");
const Case = require("../modules/task/models/case.model.js");
const Listing = require("../modules/catalog/models/listing.model.js");
const ProductTypeGroup = require("../modules/catalog/models/productTypeGroup.model.js");
const ConfigCostCenter = require("../modules/system/models/configCostCenter.model.js");
const ConfigOptionMapping = require("../modules/system/models/configOptionMapping.js");
const Report = require("../modules/report/models/report.model.js");
const Ads = require("../modules/report/models/ads.model.js");
const SkuMappingConfig = require("../modules/catalog/models/skuMappingConfig.model.js");
const SkuMappingEntry = require("../modules/catalog/models/skuMappingEntry.model.js");
const PsdTask = require("../modules/task/models/psdTask.model.js");
const IdeaTask = require("../modules/task/models/ideaTask.model.js");
const RealtimeLog = require("../modules/system/models/realtimeLog.model.js");
const Team = require("../modules/team/models/team.model.js");
const PointLog = require("../modules/system/models/pointLogs.model.js");
const OrderHistory = require("../modules/order/models/orderHistory.model.js");
const ShippingBatch = require("../modules/fulfillment/models/shippingBatch.model.js");
const Project = require("../modules/task/models/project.model.js");
const Category = require("../modules/catalog/models/category.model.js")
const Notification = require("../modules/system/models/notification.model.js")
const Issue = require("../modules/task/models/issue.model.js");
const EtsyOrder = require("../modules/order/models/etsyOrder.model.js");
const EtsyListing = require("../modules/catalog/models/etsyListing.model.js");

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
db.SkuMappingConfig = SkuMappingConfig;
db.SkuMappingEntry = SkuMappingEntry;
db.PsdTask = PsdTask;
db.IdeaTask = IdeaTask;
db.RealtimeLog = RealtimeLog;
db.Team = Team;
db.PointLog = PointLog;
db.OrderHistory = OrderHistory;
db.ShippingBatch = ShippingBatch;
db.Project = Project
db.Category = Category
db.Notification = Notification
db.Issue = Issue
db.EtsyOrder = EtsyOrder;
db.EtsyListing = EtsyListing;
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

