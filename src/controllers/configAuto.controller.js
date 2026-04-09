// controllers/configAuto.controller.js
const db = require("../models");
const ConfigAuto = db.ConfigAuto;
const cronJobService = require("../service/cronJobs");

/**
 * Lấy danh sách tất cả config auto
 * GET /api/config-auto
 */
const getAllConfigAuto = async (req, res, next) => {
  try {
    const { type, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (type) filter.type = type;

    const skip = (page - 1) * limit;

    const configs = await ConfigAuto.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await ConfigAuto.countDocuments(filter);

    return res.json({
      ok: true,
      data: configs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Lấy config auto theo ID
 * GET /api/config-auto/:id
 */
const getConfigAutoById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const config = await ConfigAuto.findOne({ id });
    if (!config) {
      return res.status(404).json({
        ok: false,
        message: `Config with id '${id}' not found`
      });
    }

    return res.json({
      ok: true,
      data: config
    });

  } catch (error) {
    next(error);
  }
};

/**
 * Cập nhật config auto
 * PUT /api/config-auto/:id
 */
const updateConfigAuto = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, autoTime, status, description, config } = req.body;

    const existingConfig = await ConfigAuto.findOne({ id });
    if (!existingConfig) {
      return res.status(404).json({
        ok: false,
        message: `Config with id '${id}' not found`
      });
    }

    const oldStatus = existingConfig.status;

    // Update fields
    if (type) existingConfig.type = type;
    if (autoTime) existingConfig.autoTime = autoTime;
    if (typeof status === 'boolean') existingConfig.status = status;
    if (description !== undefined) existingConfig.description = description;
    if (config) existingConfig.config = { ...existingConfig.config, ...config };

    await existingConfig.save();

    // Handle cron job changes
    if (oldStatus !== existingConfig.status || autoTime) {
      if (oldStatus === true) {
        // Stop old job
        await cronJobService.removeAutoJob(id);
      }
      
      if (existingConfig.status === true) {
        // Start new job
        await cronJobService.addAutoJob(existingConfig);
      }
    }

    return res.json({
      ok: true,
      message: "Config auto updated successfully",
      data: existingConfig
    });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllConfigAuto,
  getConfigAutoById,
  updateConfigAuto
};