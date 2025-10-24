const db = require("../models");
const mongoose = require("mongoose");
const Team = db.Team;
const User = db.user;

const addMembersToTeam = async (teamId, userIds) => { 
    if (!teamId) { 
        const error = new Error("Team id missing");
        error.statusCode = 400;
        throw error;
    } 
    
    if (!mongoose.isValidObjectId(teamId)) { 
        const error = new Error("Invalid team id");
        error.statusCode = 400;
        throw error;
    }
    const validUserIds = validateUserIds(userIds);
 
    const team = await Team.findById(teamId).lean(); 
    if (!team) {
        const error = new Error("Team not found");
        error.statusCode = 404;
        throw error;
    }
 
    if (!team.active) {
        const error = new Error("Team is inactive");
        error.statusCode = 400;
        throw error;
    }
 
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        const usersToMove = await User.find(
            { 
                _id: { $in: validUserIds }, 
                team_id: { $exists: true, $ne: null, $ne: teamId } 
            },
            { team_id: 1 }
        ).session(session).lean();
        
        const oldTeamCounts = {};
        usersToMove.forEach(user => {
            const oldTeamId = String(user.team_id);
            oldTeamCounts[oldTeamId] = (oldTeamCounts[oldTeamId] || 0) + 1;
        });
     
        const result = await User.updateMany( 
            { 
                _id: { $in: validUserIds }, 
                team_id: { $ne: teamId } 
            }, 
            { $set: { team_id: teamId } }, 
            { runValidators: true, session } 
        ); 
     
        if (result.modifiedCount > 0) {
            const bulkOps = [];
            
            for (const [oldTeamId, count] of Object.entries(oldTeamCounts)) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: mongoose.Types.ObjectId.createFromHexString(oldTeamId) },
                        update: { $inc: { totalMembers: -count } }
                    }
                });
            }
            
            bulkOps.push({
                updateOne: {
                    filter: { _id: mongoose.Types.ObjectId.createFromHexString(teamId) },
                    update: { $inc: { totalMembers: result.modifiedCount } }
                }
            });
            
            await Team.bulkWrite(bulkOps, { session });
        }
        
        await session.commitTransaction();
     
        return { 
            matched: result.matchedCount, 
            modified: result.modifiedCount,
            teamId: teamId
        };
        
    } catch (error) {
        await session.abortTransaction();
        throw error;
        
    } finally {
        session.endSession();
    }
};

const validateUserIds = (userIds) => {
    if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ message: "userIds must be a non-empty array" });
    }
    const validUserIds = userIds
        .filter(id => mongoose.isValidObjectId(id))
        .map(id => mongoose.Types.ObjectId.createFromHexString(id));
    
    if (validUserIds.length === 0) {
        const error = new Error("No valid user IDs provided");
        error.statusCode = 400;
        throw error;
    }
    return validUserIds;
}

module.exports = {
    addMembersToTeam,
    validateUserIds
}