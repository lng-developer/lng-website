// src/middleware/errorHandler.js
const logger = require("./logger");

/**
 * Centralized error handler middleware.
 * Phải đặt SAU tất cả routes trong Express app.
 * Signature 4 tham số (err, req, res, next) là bắt buộc để Express nhận diện error middleware.
 */
function errorHandler(err, req, res, _next) {
    // Determine status code
    const statusCode = err.status || err.statusCode || 500;
    const isServerError = statusCode >= 500;

    // Log
    const logPayload = {
        method: req.method,
        url: req.originalUrl,
        statusCode,
        ip: req.ip,
        ...(err.code && { code: err.code }),
        ...(isServerError && { stack: err.stack }),
    };

    if (isServerError) {
        logger.error(err.message, logPayload);
    } else {
        logger.warn(err.message, logPayload);
    }

    // Response
    res.status(statusCode).json({
        error: {
            message: isServerError && process.env.NODE_ENV === "production"
                ? "Internal Server Error"
                : err.message || "Internal Server Error",
            ...(err.code && { code: err.code }),
            ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
        },
    });
}

module.exports = errorHandler;

