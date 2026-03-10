const psdTaskService = require("../services/psdTask.service");

class PsdTaskController {
  async getTasks(req, res) {
    try {
      const result = await psdTaskService.getTasks(req.query, req.user);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  async getTaskStatistics(req, res) {
    try {
      const result = await psdTaskService.getTaskStatistics(req.query, req.user);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  async requestPSD(req, res) {
    try {
      const { taskId, note } = req.body;
      const task = await psdTaskService.requestPSD(taskId, note, req.user);
      res.json(task);
    } catch (e) {
      res.status(500).json({ message: e.message });
    }
  }

  async assignDesigner(req, res) {
    try {
      const { taskId } = req.params;
      const { designer, priority, difficulty, dueAt } = req.body;
      const task = await psdTaskService.changeStatus(
        taskId,
        "Assigned",
        req.user.userId,
        "Assign designer",
        null,
        { designer, priority, difficulty, dueAt }
      );
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  async startTask(req, res) {
    try {
      const { taskId } = req.params;
      const task = await psdTaskService.changeStatus(
        taskId,
        "In Progress",
        req.user.userId,
        "Start doing"
      );
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  async uploadPSD(req, res) {
    try {
      const { taskId } = req.params;
      const { asin, status } = req.body;
      const result = await psdTaskService.uploadPSD(
        taskId,
        asin,
        req.file,
        req.user,
        status
      );
      return res.json(result);
    } catch (err) {
      console.error("Error updating design file:", err);
      return res.status(500).json({ message: err.message });
    }
  }

  async qcPSD(req, res) {
    try {
      const { taskId } = req.params;
      const { result, note } = req.body;
      const task = await psdTaskService.qcPSD(taskId, result, note, req.user);
      res.json(task);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  async deletePsdTask(req, res) {
    try {
      const { taskId } = req.params;
      const result = await psdTaskService.deletePsdTask(taskId, req.user);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
}

module.exports = new PsdTaskController();

