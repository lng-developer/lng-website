// utils/response.js
const sendResponse = (res, statusCode, success, message, data = null, error = null, meta = null) => {
  const payload = { success, message, data };

  if (meta) payload.meta = meta;        // chứa pagination, sort, filter, v.v.
  if (error) payload.error = error;

  if (statusCode >= 400) {
    console.warn(`[API Error] ${message}`, error);
  }

  return res.status(statusCode).json(payload);
};

const success = (res, message = "Success", data = null, meta = null) =>
  sendResponse(res, 200, true, message, data, null, meta);


const fail = (res, statusCode = 400, message = "Failed", error = null, meta = null) =>
  sendResponse(res, statusCode, false, message, null, error, meta);

const buildPagination = (page, limit, total) => {
  const totalPages = Math.ceil(total / limit) || 1;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    nextPage: page < totalPages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
};

module.exports = {
  sendResponse,
  success,
  fail,
  buildPagination,
};
