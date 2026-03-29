// src/shared/index.js
// Shared Kernel – centralized re-exports for cross-cutting concerns
// Modules should import from here instead of relative paths to middleware/utils/config

// ── Middleware ──
const { authenticateToken, authorizeRoles } = require("../middleware/auth.middleware");
const { success, fail } = require("../middleware/response");
const logger = require("../middleware/logger");
const errorHandler = require("../middleware/errorHandler");
const requestLogger = require("../middleware/requestLogger");

// ── Utils ──
const cloudinary = require("../utils/cloudinary");
const wasabi = require("../utils/wasabi");
const connectToDatabase = require("../utils/mongodb");

// ── Config ──
const authConfig = require("../config/auth.config");
const connectDB = require("../config/db.config");

module.exports = {
  // Middleware
  authenticateToken,
  authorizeRoles,
  success,
  fail,
  logger,
  errorHandler,
  requestLogger,

  // Utils
  cloudinary,
  ...wasabi, // uploadBufferToWasabi, getSignedUrlForKey, objectExists, buildPsdKeyFromAsin, s3
  connectToDatabase,

  // Config
  authConfig,
  connectDB,
};
