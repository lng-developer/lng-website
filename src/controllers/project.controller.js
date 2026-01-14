// controllers/trello/project.controller.js
const db = require("../models");
const Project = db.Project
const User = db.user;
const Role = db.role;
const { toObjectId, getUserId, assertProjectMember } = require("../helper/toDoList.helper.js");

async function createProject(req, res) {
  try {
    const userId = getUserId(req);
    const { name, description = "", memberIds = [] } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: "Missing project name" });

    const doc = await Project.create({
      name: String(name).trim(),
      description: String(description || ""),
      ownerId: toObjectId(userId),
      memberIds: (Array.isArray(memberIds) ? memberIds : []).map(toObjectId),
      status: "active",
    });

    return res.json({ data: doc });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || "Server error" });
  }
}

async function listProjects(req, res) {
  try {
    const userId = toObjectId(getUserId(req));
    const { status = "active", search = "" } = req.query || {};

    // ===== check admin via role_id -> Role.name =====
    const me = await User.findById(userId).select({ role_id: 1 }).lean();
    if (!me) return res.status(401).json({ message: "Unauthorized" });

    const role = me.role_id
      ? await Role.findById(me.role_id).select({ name: 1 }).lean()
      : null;

    const isAdmin = String(role?.name || "").toLowerCase() === "admin";
    // ==============================================

    // ===== base query =====
    const q = {
      status: status === "all" ? { $in: ["active", "archived"] } : String(status),
    };
    if (search) q.name = { $regex: String(search).trim(), $options: "i" };

    if (!isAdmin) {
      q.$or = [{ ownerId: userId }, { memberIds: userId }];
    }

    const projects = await Project.find(q)
      .sort({ updatedAt: -1 })
      .lean();

    // ===================== populate memberIds -> full_name =====================
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

      // optional: nếu không muốn FE dùng memberIds nữa
      // delete p.memberIds;
    }
    // ===================== end populate =====================

    return res.json({ data: projects });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Server error" });
  }
}



async function getProjectDetail(req, res) {
  try {
    const userId = getUserId(req);
    const { projectId } = req.params;

    const project = await assertProjectMember({ projectId, userId });
    return res.json({ data: project });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || "Server error" });
  }
}

async function updateProject(req, res) {
  try {
    const userId = getUserId(req);
    const { projectId } = req.params;
    const { name, description, memberIds, status } = req.body || {};

    await assertProjectMember({ projectId, userId });

    const update = {};
    if (typeof name === "string") update.name = String(name).trim();
    if (typeof description === "string") update.description = String(description);
    if (Array.isArray(memberIds)) update.memberIds = memberIds.map(toObjectId);
    if (["active", "archived"].includes(String(status))) update.status = String(status);

    const doc = await Project.findByIdAndUpdate(toObjectId(projectId), { $set: update }, { new: true }).lean();
    return res.json({ data: doc });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || "Server error" });
  }
}

async function archiveProject(req, res) {
  try {
    const userId = getUserId(req);
    const { projectId } = req.params;
    await assertProjectMember({ projectId, userId });

    const doc = await Project.findByIdAndUpdate(
      toObjectId(projectId),
      { $set: { status: "archived" } },
      { new: true }
    ).lean();

    return res.json({ data: doc });
  } catch (e) {
    return res.status(e.status || 500).json({ message: e.message || "Server error" });
  }
}

module.exports = {
  createProject,
  listProjects,
  getProjectDetail,
  updateProject,
  archiveProject,
};
