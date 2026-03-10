const authModule = require("../modules/auth/routes");
const catalogModule = require("../modules/catalog/routes");
const fulfillmentModule = require("../modules/fulfillment/routes");
const orderModule = require("../modules/order/routes");
const reportModule = require("../modules/report/routes");
const systemModule = require("../modules/system/routes");
const taskModule = require("../modules/task/routes");
const teamModule = require("../modules/team/routes");
const vendorModule = require("../modules/vendor/routes");

module.exports = {
  authModule,
  catalogModule,
  fulfillmentModule,
  orderModule,
  reportModule,
  systemModule,
  taskModule,
  teamModule,
  vendorModule,
};

