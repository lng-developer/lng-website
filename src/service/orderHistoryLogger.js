const db = require('../models');
const OrderHistory = db.OrderHistory

async function logOrderHistory({
  orderDoc,
  action,
  description = "",
  changes = [],
  orderItemId = null,
  user = {},
  context = {},
}) {
  if (!orderDoc) return;

  const { _id: orderObjectId, orderId } = orderDoc;

  await OrderHistory.create({
    order: orderObjectId,
    orderId,
    action,
    description,
    changes,
    orderItemId,
    userId: user._id || null,
    userName: user.name || null,
    userRole: user.role || null,
    source: context.source || "PORTAL",
    ip: context.ip || null,
    userAgent: context.userAgent || null,
  });
}

module.exports = { logOrderHistory };
