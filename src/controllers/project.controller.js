// controllers/trello/project.controller.js
const db = require("../models");
const Project = db.Project
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

    const q = {
      status: status === "all" ? { $in: ["active", "archived"] } : String(status),
      $or: [{ ownerId: userId }, { memberIds: userId }],
    };
    if (search) q.name = { $regex: String(search).trim(), $options: "i" };

    const projects = await Project.find(q).sort({ updatedAt: -1 }).lean();
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
