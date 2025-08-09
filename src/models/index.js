// src/models/index.js
const mongoose = require('mongoose')
const User = require('./user.model')
const Role = require('./role.model')
const Account = require('./account.model')
const OrderCustomProduct = require('./orderCustomProduct.model')
const Shop = require('./shop.model')
const Vendor = require('./vendor.model')
const VendorProduct = require('./vendorProduct.model')
const VendorCostCenter = require('./vendorCostCenter.model')
const Case = require('./case.model')
const Listing = require('./listing.model')


// Cau hinh mongoose dang global
mongoose.Promise = global.Promise
// Dinh nghia doi tuong DB
const db = {}
db.mongoose = mongoose

// Bo sung cac thuoc tinh cho DB
db.user = User
db.role = Role
db.account = Account
db.orderCustomProduct = OrderCustomProduct
db.shop = Shop
db.vendor = Vendor
db.vendorProduct = VendorProduct
db.vendorCostCenter = VendorCostCenter
db.case = Case
db.listing = Listing
db.connectDB = async () => {
    await mongoose.connect(process.env.MONGO_URI, {
        dbName: process.env.DB_NAME
    })
        .then(() => console.log("Connect to MongoDB success"))
        .catch(error => {
            console.error(error.message);
            process.exit()
        })
}

module.exports = db