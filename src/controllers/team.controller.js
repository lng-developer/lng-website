const db = require("../models");
const mongoose = require("mongoose");
const teamHelper = require("../helper/teamHelper");
const logger = require("../helper/logger");
const Team = db.Team;
const User = db.user;
const { success, fail, buildPagination } = require("../helper/response");

// ==================== PUBLIC ROUTES ====================

const getTeams = async (req, res) => {
    try {
        const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const q = String(req.query.search || '').trim();
        const rx = q ? new RegExp(escapeRegex(q), 'i') : null;

        const pipeline = [
          { $match: { active: true } },
          { $lookup: { from: 'users', localField: 'userIds', foreignField: '_id', as: 'members' } },
        ];

        if (rx) {
          pipeline.push({
            $match: {
              $or: [
                { name: rx },
                { 'members.full_name': rx },
              ]
            }
          });
        }

        pipeline.push({
          $project: {
            id: '$_id',
            name: 1,
            active: 1,
            leaderId: 1,
            members: {
              $map: {
                input: '$members',
                as: 'm',
                in: { _id: '$$m._id', full_name: '$$m.full_name' }
              }
            }
          }
        });

        const result = await Team.aggregate(pipeline);
        return success(res, 'Get Team List successful', result);

    } catch (e) {
        logger.error(`Get teams error: ${e.message}`);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const getTeamMembers = async (req, res) => {
    try {
        const { teamId } = req.params;
        
        if (!mongoose.isValidObjectId(teamId)) {
            return fail(res, 400, "Invalid team id");
        }
        
        const team = await Team.findById(teamId)
            .populate('userIds')
            .lean();
        
        if (!team) {
            return fail(res, 404, "Team not found");
        }
        return success(res, "Get Team Members successful", {
            teamId: team._id,
            teamName: team.name,
            totalMembers: team.userIds.length,
            members: team.userIds
        });
    } catch (e) {
        logger.error(`Get team members error: ${e.message}`);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const createTeam = async (req, res) => {
  try {
    const { name, userIds, leaderId } = req.body;

    if (!name?.trim()) return fail(res, 400, "Team name is required");
    const trimmedName = name.trim();

    const existingTeam = await Team.findOne({ name: trimmedName }).lean();
    if (existingTeam) return fail(res, 400, "Team name already exists");

    let validProvidedIds = Array.isArray(userIds)
      ? userIds.filter((id) => mongoose.isValidObjectId(id))
      : [];

    let existingUsers = [];
    if (validProvidedIds.length > 0) {
      existingUsers = await User.find({ _id: { $in: validProvidedIds } })
        .select("_id full_name email team_id")
        .lean();
    }

    const { addMembs, alreadyInTeam } = existingUsers.reduce(
      (acc, u) => {
        if (u.team_id) acc.alreadyInTeam.push(u);
        else acc.willBeAddedIds.push(u._id);
        return acc;
      },
      { addMembs: [], alreadyInTeam: [] }
    );

    const team = await Team.create({
      name: trimmedName,
      leaderId: leaderId,
      active: true,
    });

    let updateResult = { matchedCount: 0, modifiedCount: 0 };
    if (addMembs.length > 0) {
      const result = await User.updateMany(
        { _id: { $in: addMembs }, team_id: { $exists: false } },
        { $set: { team_id: team._id } }
      );
      updateResult = { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
    }
    return success(res, "Team created successfully", {
      team: {
        id: team._id,
        name: team.name,
        active: team.active,
      },
      members: {
        addedCount: updateResult.modifiedCount,
        addedUserIds: addMembs,
        skippedAlreadyInTeam: alreadyInTeam.map((u) => ({
          _id: u._id,
          full_name: u.full_name,
          email: u.email,
          team_id: u.team_id,
        })),
      },
    });
  } catch (e) {
    return fail(res, 500, "Internal Server Error", { message: e.message });
  }
};

const addMembers = async (req, res) => { 
    try { 
        const { teamId } = req.params;
        const { userIds } = req.body;
        
        if (!mongoose.isValidObjectId(teamId)) {
            return fail(res, 400, "Invalid team id");
        }
        
        if (!Array.isArray(userIds) || userIds.length === 0) {
            return fail(res, 400, "userIds must be a non-empty array");
        }
        
        logger.info(`Adding members to team: ${teamId}`, { userIds });
        
        const validUserIds = userIds.filter(id => mongoose.isValidObjectId(id));
        
        if (validUserIds.length === 0) {
            return fail(res, 400, "No valid user IDs");
        }
        
        const session = await mongoose.startSession();
        session.startTransaction();
        
        try {
            // Check team exists and active
            const team = await Team.findById(teamId).session(session);
            if (!team) {
                await session.abortTransaction();
            return fail(res, 404, "Team not found");
            }
            
            if (!team.active) {
                await session.abortTransaction();
                return fail(res, 400, "Team is inactive");
            }
            
            // Get users that will be moved (have different team_id)
            const usersToMove = await User.find({
                _id: { $in: validUserIds },
                team_id: { $ne: teamId }
            }).select('_id team_id').session(session);
            
            if (usersToMove.length === 0) {
                await session.abortTransaction();
                return fail(res, 400, "All users already in this team");
            }
            
            const userIdsToMove = usersToMove.map(u => u._id);
            const oldTeamIds = [...new Set(usersToMove
                .filter(u => u.team_id)
                .map(u => String(u.team_id))
            )];
            
            // Remove users from old teams' userIds array
            if (oldTeamIds.length > 0) {
                await Team.updateMany(
                    { _id: { $in: oldTeamIds } },
                    { $pull: { userIds: { $in: userIdsToMove } } },
                    { session }
                );
            }
            
            // Add users to new team's userIds array
            await Team.updateOne(
                { _id: teamId },
                { $addToSet: { userIds: { $each: userIdsToMove } } },
                { session }
            );
            
            // Update users' team_id
            await User.updateMany(
                { _id: { $in: userIdsToMove } },
                { $set: { team_id: teamId } },
                { session }
            );
            
            await session.commitTransaction();
            
            logger.info(`Members added to team: ${teamId}`, { count: userIdsToMove.length });
            return success(res, "Members added successfully", {
                                teamId,
                                addedCount: userIdsToMove.length
            });
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
        
    } catch (e) { 
        logger.error(`Add members error: ${e.message}`);
        return fail(res, 500, "Internal Server Error", e);
    } 
};

const deleteTeam = async (req, res) => {
    try {
        const { teamId } = req.params;
        
        if (!mongoose.isValidObjectId(teamId)) {
            return fail(res, 400, "Invalid team id");
        }
        
        const team = await Team.findByIdAndUpdate(
            teamId,
            { $set: { active: false } },
            { new: true }
        );
        
        if (!team) {
            return fail(res, 404, "Team not found");
        }
        return success(res, "Team deleted successfully");
        
    } catch (e) {
        logger.error(`Delete team error: ${e.message}`);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const removeMembers = async (req, res) => {
    try {
        const { teamId } = req.params;
        const { userIds } = req.body;
        
        if (!mongoose.isValidObjectId(teamId)) {
            return fail(res, 400, "Invalid team id");
        }
        
        if (!Array.isArray(userIds) || userIds.length === 0) {
            return fail(res, 400, "userIds must be a non-empty array");
        }
        
        const validUserIds = userIds.filter(id => mongoose.isValidObjectId(id));
        
        const session = await mongoose.startSession();
        session.startTransaction();
        
        try {
            // Remove from team's userIds
            const result = await Team.updateOne(
                { _id: teamId },
                { $pull: { userIds: { $in: validUserIds } } },
                { session }
            );
            
            // Clear users' team_id
            await User.updateMany(
                { _id: { $in: validUserIds }, team_id: teamId },
                { $unset: { team_id: "" } },
                { session }
            );
            
            await session.commitTransaction();
            return success(res, "Members removed successfully",
                    { removedCount: result.modifiedCount });
        } catch (error) {
            await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
        
    } catch (e) {
        logger.error(`Remove members error: ${e.message}`);
        return fail(res, 500, "Internal Server Error", e);
    }
};

const updateTeam = async (req, res) => {
    try {
        const { teamId } = req.params;
        const { name, leaderId, active } = req.body;
        
        if (!mongoose.isValidObjectId(teamId)) {
            return fail(res, 400, "Invalid team id");
        }
        
        const updates = {};
        if (name?.trim()) updates.name = name.trim();
        if (active !== undefined) updates.active = Boolean(active);
        if (leaderId !== undefined) updates.leaderId = leaderId;

        if (Object.keys(updates).length === 0) {
            return success(res);
        }
        
        // Check duplicate name
        if (name) {
            const duplicate = await Team.findOne({ 
                name: name.trim(), 
                _id: { $ne: teamId } 
            });
            if (duplicate) {
                return fail(res, 400, "Team name already exists");
            }
        }
        const results = await Promise.allSettled([
            Team.findByIdAndUpdate(teamId, { $unset: { leaderId: '' } }, { new: true, runValidators: true }),
            Team.findByIdAndUpdate(teamId, { $set: updates }, { new: true, runValidators: true }).select('name active userIds')
        ]);

        const team = results[1].value;
        if (!team) {
            return fail(res, 404, "Team not found");
        }
        return success(res,"Team updated successfully",
            {
                id: team._id,
                name: team.name,
                active: team.active,
                totalMembers: team.userIds.length
        });
        
    } catch (error) {
        logger.error(`Update team error: ${error.message}`);
        
        return fail(res, 500, "Internal Server Error", e);
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