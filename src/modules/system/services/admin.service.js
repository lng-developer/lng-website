// src/modules/system/services/admin.service.js
const db = require("../../../models");
const User = db.user;

const invalidateAllSessions = async () => {
    await User.updateMany({}, { $set: { revokeAllBefore: new Date() } });
    return { message: 'All sessions invalidated' };
};

module.exports = {
    invalidateAllSessions
};

