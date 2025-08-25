const roleController = require('./role.controller');
const userController = require('./user.controller');
const accountController = require('./account.controller');
const authController = require('./auth.controller');
const orderCustomProductController = require('./orderCustomProduct.controller');
const shopController = require('./shop.controller')
const vendorController = require('./vendor.controller')
const vendorProductController = require('./vendorProduct.controller')
const vendorCostCenterController = require('./vendorCostCenter.controller')
const caseController = require('./case.controller');
const listingController = require('./listing.controller');
const productTypeController = require('./productType.controller')
const configCostCenterController = require('./configCostCenter.controller')
const scaleController = require('./scale.controller')
const configOptionMapping = require('./configOptionMapping.controller')
const QCController = require('./qc.controller')


module.exports = {
    roleController,
    userController,
    accountController,
    authController,
    orderCustomProductController,
    shopController,
    vendorController,
    vendorProductController,
    vendorCostCenterController,
    caseController,
    listingController,
    productTypeController,
    configCostCenterController,
    scaleController,
    configOptionMapping,
    QCController
};
