// src/middleware/requestLogger.js
const morgan = require("morgan");
const logger = require("./logger");

/**
 * HTTP request logger middleware (morgan → winston).
 * Dev: colored short format to console
 * Prod: combined format to winston files
 */
const requestLogger = morgan(
    process.env.NODE_ENV === "production" ? "combined" : "dev",
    { stream: logger.stream }
);

module.exports = requestLogger;

