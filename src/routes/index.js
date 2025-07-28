const roleRoutes = require('./role.routes');
const userRoutes = require('./user.routes');
const accountRoutes = require('./account.routes');
const authRoutes = require('./auth.routes');
const orderCustomProductRoutes = require('./orderCustomProduct.routes');
const shopRoutes = require('./shop.routes')
const vendorRoutes = require('./vendor.routes')
const vendorProductRoutes = require('./vendorProduct.routes')
const vendorCostCenterRoutes = require('./vendorCostCenter.routes')

module.exports = {
    roleRoutes,
    userRoutes,
    accountRoutes,
    authRoutes,
    orderCustomProductRoutes,
    shopRoutes,
    vendorRoutes,
    vendorProductRoutes,
    vendorCostCenterRoutes
};
