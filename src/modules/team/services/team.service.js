// src/modules/team/services/team.service.js
const db = require("../../../models");
const mongoose = require("mongoose");
const logger = require("../../../middleware/logger");
const Team = db.Team;
const User = db.user;

const getTeams = async (searchQuery) => {
    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const q = String(searchQuery || '').trim();
    const rx = q ? new RegExp(escapeRegex(q), 'i') : null;

    const pipeline = [];

    pipeline.push({ $match: { active: true } });

    pipeline.push({
        $lookup: {
            from: 'users',
            localField: 'leaderId',
            foreignField: '_id',
            as: 'leader'
        }
    });

    pipeline.push({
        $unwind: {
            path: '$leader',
            preserveNullAndEmptyArrays: true
        }
    });

    pipeline.push({
        $lookup: {
            from: 'roles',
            localField: 'leader.role_id',
            foreignField: '_id',
            as: 'leaderRole'
        }
    });

    pipeline.push({
        $unwind: {
            path: '$leaderRole',
            preserveNullAndEmptyArrays: true
        }
    });

    pipeline.push({
        $lookup: {
            from: 'users',
            localField: 'userIds',
            foreignField: '_id',
            as: 'members',
            ...(rx && {
                pipeline: [
                    { $match: { full_name: rx } }
                ]
            })
        }
    });

    if (rx) {
        pipeline.push({
            $match: {
                $or: [
                    { name: rx },
                    { 'members.0': { $exists: true } }
                ]
            }
        });
    }

    pipeline.push({
        $unwind: {
            path: '$members',
            preserveNullAndEmptyArrays: true
        }
    });

    pipeline.push({
        $lookup: {
            from: 'roles',
            localField: 'members.role_id',
            foreignField: '_id',
            as: 'memberRole'
        }
    });

    pipeline.push({
        $unwind: {
            path: '$memberRole',
            preserveNullAndEmptyArrays: true
        }
    });

    pipeline.push({
        $group: {
            _id: '$_id',
            name: { $first: '$name' },
            active: { $first: '$active' },
            leader: {
                $first: {
                    $cond: {
                        if: '$leader._id',
                        then: {
                            _id: '$leader._id',
                            full_name: '$leader.full_name',
                            role: {
                                _id: '$leaderRole._id',
                                name: '$leaderRole.name'
                            }
                        },
                        else: null
                    }
                }
            },
            members: {
                $push: {
                    $cond: {
                        if: '$members._id',
                        then: {
                            _id: '$members._id',
                            full_name: '$members.full_name',
                            role: {
                                _id: '$memberRole._id',
                                name: '$memberRole.name'
                            }
                        },
                        else: '$$REMOVE'
                    }
                }
            }
        }
    });

    pipeline.push({
        $project: {
            name: 1,
            active: 1,
            leader: 1,
            members: 1
        }
    });
    return await Team.aggregate(pipeline);
};

const getTeamMembers = async (teamId) => {
    if (!mongoose.isValidObjectId(teamId)) {
        const error = new Error("Invalid team id");
        error.status = 400;
        throw error;
    }

    const team = await Team.findById(teamId)
        .populate('userIds')
        .lean();

    if (!team) {
        const error = new Error("Team not found");
        error.status = 404;
        throw error;
    }
    return {
        teamId: team._id,
        teamName: team.name,
        totalMembers: team.userIds.length,
        members: team.userIds
    };
};

const createTeam = async (teamData) => {
    const { name, userIds, leaderId } = teamData;

    if (!name?.trim()) {
        const error = new Error("Team name is required");
        error.status = 400;
        throw error;
    }
    const trimmedName = name.trim();

    const existingTeam = await Team.findOne({ name: trimmedName }).lean();
    if (existingTeam) {
        const error = new Error("Team name already exists");
        error.status = 400;
        throw error;
    }

    const validProvidedIds = Array.isArray(userIds)
        ? userIds.filter((id) => mongoose.isValidObjectId(id))
        : [];

    let existingUsers = [];
    if (validProvidedIds.length) {
        existingUsers = await User.find({ _id: { $in: validProvidedIds } })
            .select("_id full_name email team_id")
            .lean();
    }

    const { addMembs, alreadyInTeam } = existingUsers.reduce(
        (acc, u) => {
            if (u.team_id) acc.alreadyInTeam.push(u);
            else acc.addMembs.push(u._id);
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
        const userUpdate = await User.updateMany(
            { _id: { $in: addMembs }, team_id: { $exists: false } },
            { $set: { team_id: team._id } }
        );
        updateResult = {
            matchedCount: userUpdate.matchedCount ?? userUpdate.n ?? 0,
            modifiedCount: userUpdate.modifiedCount ?? userUpdate.nModified ?? 0,
        };

        await Team.updateOne(
            { _id: team._id },
            { $addToSet: { userIds: { $each: addMembs } } }
        );
    }

    const addedUserIdsStr = addMembs.map((id) => id.toString());

    return {
        team: {
            id: team._id.toString(),
            name: team.name,
            active: team.active,
        },
        members: {
            addedCount: updateResult.modifiedCount,
            addedUserIds: addedUserIdsStr,
            skippedAlreadyInTeam: alreadyInTeam.map((u) => ({
                _id: u._id.toString(),
                full_name: u.full_name,
                email: u.email,
                team_id: u.team_id ? u.team_id.toString() : null,
            })),
        },
    };
};

const addMembers = async (teamId, userIds) => {
    if (!mongoose.isValidObjectId(teamId)) {
        const error = new Error("Invalid team id");
        error.status = 400;
        throw error;
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
        const error = new Error("userIds must be a non-empty array");
        error.status = 400;
        throw error;
    }

    logger.info(`Adding members to team: ${teamId}`, { userIds });

    const validUserIds = userIds.filter(id => mongoose.isValidObjectId(id));

    if (validUserIds.length === 0) {
        const error = new Error("No valid user IDs");
        error.status = 400;
        throw error;
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const team = await Team.findById(teamId).session(session);
        if (!team) {
            await session.abortTransaction();
            const error = new Error("Team not found");
            error.status = 404;
            throw error;
        }

        if (!team.active) {
            await session.abortTransaction();
            const error = new Error("Team is inactive");
            error.status = 400;
            throw error;
        }

        const usersToMove = await User.find({
            _id: { $in: validUserIds },
            team_id: { $ne: teamId }
        }).select('_id team_id').session(session);

        if (usersToMove.length === 0) {
            await session.abortTransaction();
            const error = new Error("All users already in this team");
            error.status = 400;
            throw error;
        }

        const userIdsToMove = usersToMove.map(u => u._id);
        const oldTeamIds = [...new Set(usersToMove
            .filter(u => u.team_id)
            .map(u => String(u.team_id))
        )];

        if (oldTeamIds.length > 0) {
            await Team.updateMany(
                { _id: { $in: oldTeamIds } },
                { $pull: { userIds: { $in: userIdsToMove } } },
                { session }
            );
        }

        await Team.updateOne(
            { _id: teamId },
            { $addToSet: { userIds: { $each: userIdsToMove } } },
            { session }
        );

        await User.updateMany(
            { _id: { $in: userIdsToMove } },
            { $set: { team_id: teamId } },
            { session }
        );

        await session.commitTransaction();

        logger.info(`Members added to team: ${teamId}`, { count: userIdsToMove.length });
        return {
            teamId,
            addedCount: userIdsToMove.length
        };
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        session.endSession();
    }
};

const deleteTeam = async (teamId) => {
    if (!mongoose.isValidObjectId(teamId)) {
        const error = new Error("Invalid team id");
        error.status = 400;
        throw error;
    }

    const team = await Team.findByIdAndUpdate(
        teamId,
        { $set: { active: false } },
        { new: true }
    );

    if (!team) {
        const error = new Error("Team not found");
        error.status = 404;
        throw error;
    }
};

const removeMembers = async (teamId, userIds) => {
    if (!mongoose.isValidObjectId(teamId)) {
        const error = new Error("Invalid team id");
        error.status = 400;
        throw error;
    }

    if (!Array.isArray(userIds) || userIds.length === 0) {
        const error = new Error("userIds must be a non-empty array");
        error.status = 400;
        throw error;
    }

    const validUserIds = userIds.filter(id => mongoose.isValidObjectId(id));

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const result = await Team.updateOne(
            { _id: teamId },
            { $pull: { userIds: { $in: validUserIds } } },
            { session }
        );

        await User.updateMany(
            { _id: { $in: validUserIds }, team_id: teamId },
            { $unset: { team_id: "" } },
            { session }
        );

        await session.commitTransaction();
        return { removedCount: result.modifiedCount };
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        session.endSession();
    }
};

const updateTeam = async (teamId, updateData) => {
    if (!mongoose.isValidObjectId(teamId)) {
        const error = new Error("Invalid team id");
        error.status = 400;
        throw error;
    }

    const { name, leaderId, active } = updateData;

    const updates = {};
    if (name?.trim()) updates.name = name.trim();
    if (active !== undefined) updates.active = Boolean(active);
    if (leaderId !== undefined) updates.leaderId = leaderId;

    if (Object.keys(updates).length === 0) {
        return null;
    }

    if (name) {
        const duplicate = await Team.findOne({
            name: name.trim(),
            _id: { $ne: teamId }
        });
        if (duplicate) {
            const error = new Error("Team name already exists");
            error.status = 400;
            throw error;
        }
    }
    const results = await Promise.allSettled([
        Team.findByIdAndUpdate(teamId, { $unset: { leaderId: '' } }, { new: true, runValidators: true }),
        Team.findByIdAndUpdate(teamId, { $set: updates }, { new: true, runValidators: true }).select('name active userIds')
    ]);

    const team = results[1].value;
    if (!team) {
        const error = new Error("Team not found");
        error.status = 404;
        throw error;
    }
    return {
        id: team._id,
        name: team.name,
        active: team.active,
        totalMembers: team.userIds.length
    };
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

