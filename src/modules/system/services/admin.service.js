// src/modules/system/services/admin.service.js
const User = require("../../auth/models/user.model");

const invalidateAllSessions = async () => {
    await User.updateMany({}, { $set: { revokeAllBefore: new Date() } });
    return { message: 'All sessions invalidated' };
};

module.exports = {
    invalidateAllSessions
};

