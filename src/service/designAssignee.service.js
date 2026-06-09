const mongoose = require("mongoose");
const db = require("../models");

const User = db.user;
const Role = db.role;

const normalizeRoleName = (roleName) =>
  String(roleName || "").trim().replace(/\s+/g, " ").toLowerCase();

function buildHttpError(message, statusCode, debug) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (debug) error.debug = debug;
  return error;
}

async function getAssignableDesignUser(userId, options = {}) {
  const {
    invalidMessage = "Invalid designer",
    notFoundMessage = "Designer not found",
  } = options;

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw buildHttpError(invalidMessage, 400);
  }

  const user = await User.findById(userId)
    .select("_id full_name email role_id")
    .lean();

  if (!user) {
    throw buildHttpError(notFoundMessage, 404);
  }

  if (!user.role_id || !mongoose.Types.ObjectId.isValid(user.role_id)) {
    throw buildHttpError("User does not have a valid role_id", 400);
  }

  const role = await Role.findById(user.role_id).select("name").lean();
  const roleName = normalizeRoleName(role?.name);

  if (!["designer", "design leader"].includes(roleName)) {
    throw buildHttpError("Selected user must be Designer or Design Leader", 400, {
      userId: user._id,
      role_id: user.role_id,
      role_name: role?.name || null,
    });
  }

  return { user, role, roleName };
}

module.exports = {
  getAssignableDesignUser,
  normalizeRoleName,
};
