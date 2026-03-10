// src/modules/team/controllers/team.controller.js
const teamService = require('../services/team.service');
const { success, fail } = require("../../../middleware/response");
const logger = require("../../../middleware/logger");

const getTeams = async (req, res) => {
    try {
        const result = await teamService.getTeams(req.query.search);
        return success(res, 'Get Team List successful', result);
    } catch (e) {
        logger.error(`Get teams error: ${e.message}`);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const getTeamMembers = async (req, res) => {
    try {
        const result = await teamService.getTeamMembers(req.params.teamId);
        return success(res, "Get Team Members successful", result);
    } catch (e) {
        logger.error(`Get team members error: ${e.message}`);
        if (e.status) return fail(res, e.status, e.message);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const createTeam = async (req, res) => {
    try {
        const result = await teamService.createTeam(req.body);
        return success(res, "Team created successfully", result);
    } catch (e) {
        if (e.status) return fail(res, e.status, e.message);
        return fail(res, 500, "Internal Server Error", { message: e.message });
    }
};

const addMembers = async (req, res) => {
    try {
        const result = await teamService.addMembers(req.params.teamId, req.body.userIds);
        return success(res, "Members added successfully", result);
    } catch (e) {
        logger.error(`Add members error: ${e.message}`);
        if (e.status) return fail(res, e.status, e.message);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const deleteTeam = async (req, res) => {
    try {
        await teamService.deleteTeam(req.params.teamId);
        return success(res, "Team deleted successfully");
    } catch (e) {
        logger.error(`Delete team error: ${e.message}`);
        if (e.status) return fail(res, e.status, e.message);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const removeMembers = async (req, res) => {
    try {
        const result = await teamService.removeMembers(req.params.teamId, req.body.userIds);
        return success(res, "Members removed successfully", result);
    } catch (e) {
        logger.error(`Remove members error: ${e.message}`);
        if (e.status) return fail(res, e.status, e.message);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const updateTeam = async (req, res) => {
    try {
        const result = await teamService.updateTeam(req.params.teamId, req.body);
        if (result === null) {
            return success(res);
        }
        return success(res, "Team updated successfully", result);
    } catch (error) {
        logger.error(`Update team error: ${error.message}`);
        if (error.status) return fail(res, error.status, error.message);
        return fail(res, 500, "Internal Server Error", error);
    }
};

module.exports = {
    getTeams,
    getTeamMembers,
    createTeam,
    addMembers,
    deleteTeam,
    removeMembers,
    updateTeam,
};

