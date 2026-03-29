// src/modules/system/services/project.service.js
const Project = require("../../task/models/project.model");
const User = require("../../auth/models/user.model");
const Role = require("../../auth/models/role.model");
const { toObjectId, assertProjectMember } = require("../helpers/toDoList.helper.js");

const createProject = async (userId, projectData) => {
    const { name, description = "", memberIds = [] } = projectData;
    if (!name || !String(name).trim()) {
        const error = new Error("Missing project name");
        error.status = 400;
        throw error;
    }

    return await Project.create({
        name: String(name).trim(),
        description: String(description || ""),
        ownerId: toObjectId(userId),
        memberIds: (Array.isArray(memberIds) ? memberIds : []).map(toObjectId),
        status: "active",
    });
};

const listProjects = async (userId, { status = "active", search = "" }) => {
    const uid = toObjectId(userId);
    const me = await User.findById(uid).select({ role_id: 1 }).lean();
    if (!me) {
        const error = new Error("Unauthorized");
        error.status = 401;
        throw error;
    }

    const role = me.role_id
        ? await Role.findById(me.role_id).select({ name: 1 }).lean()
        : null;

    const isAdmin = String(role?.name || "").toLowerCase() === "admin";

    const q = {
        status: status === "all" ? { $in: ["active", "archived"] } : String(status),
    };
    if (search) q.name = { $regex: String(search).trim(), $options: "i" };

    if (!isAdmin) {
        q.$or = [{ ownerId: uid }, { memberIds: uid }];
    }

    const projects = await Project.find(q)
        .sort({ updatedAt: -1 })
        .lean();

    const memberIdSet = new Set();
    for (const p of projects) {
        if (Array.isArray(p.memberIds)) {
            for (const id of p.memberIds) memberIdSet.add(String(id));
        }
    }

    const memberIds = Array.from(memberIdSet).map(toObjectId);
    const users = memberIds.length
        ? await User.find({ _id: { $in: memberIds } })
            .select({ full_name: 1 })
            .lean()
        : [];

    const userMap = new Map(users.map(u => [String(u._id), u]));

    for (const p of projects) {
        const ids = Array.isArray(p.memberIds) ? p.memberIds : [];
        p.members = ids.map(id => {
            const u = userMap.get(String(id));
            return u
                ? { _id: u._id, full_name: u.full_name }
                : { _id: id, full_name: null };
        });
    }

    return projects;
};

const getProjectDetail = async (userId, projectId) => {
    return await assertProjectMember({ projectId, userId });
};

const updateProject = async (userId, projectId, updateData) => {
    const { name, description, memberIds, status } = updateData;
    await assertProjectMember({ projectId, userId });

    const update = {};
    if (typeof name === "string") update.name = String(name).trim();
    if (typeof description === "string") update.description = String(description);
    if (Array.isArray(memberIds)) update.memberIds = memberIds.map(toObjectId);
    if (["active", "archived"].includes(String(status))) update.status = String(status);

    return await Project.findByIdAndUpdate(toObjectId(projectId), { $set: update }, { new: true }).lean();
};

const archiveProject = async (userId, projectId) => {
    await assertProjectMember({ projectId, userId });
    return await Project.findByIdAndUpdate(
        toObjectId(projectId),
        { $set: { status: "archived" } },
        { new: true }
    ).lean();
};

module.exports = {
    createProject,
    listProjects,
    getProjectDetail,
    updateProject,
    archiveProject,
};

