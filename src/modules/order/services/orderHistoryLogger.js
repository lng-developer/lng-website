const db = require('../../../models');
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

  const userId =
    user?._id || user?.id || user?.userId || user?.uid || null;

  const userName =
    user?.name || user?.fullName || user?.username || user?.email || null;

  const userRole =
    user?.role || user?.userRole || user?.type || null;

  await OrderHistory.create({
    order: orderObjectId,
    orderId,
    action,
    description,
    changes,
    orderItemId,
    userId,
    userName,
    userRole,
    source: context.source || "PORTAL",
    ip: context.ip || null,
    userAgent: context.userAgent || null,
  });
}

module.exports = { logOrderHistory };
