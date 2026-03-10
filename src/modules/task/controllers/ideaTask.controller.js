const ideaTaskService = require("../services/ideaTask.service");
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = require("path").extname(file.originalname).toLowerCase();
    const ALLOWED_EXTS = [".psd", ".psb", ".zip"];
    if (!ALLOWED_EXTS.includes(ext)) {
      return cb(new Error("Only .psd, .psb, .zip are allowed"));
    }
    cb(null, true);
  },
});

class IdeaTaskController {
  async getAllIdeaTasks(req, res) {
    try {
      const result = await ideaTaskService.getAllIdeaTasks(req.query, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async getIdeaTaskStatistics(req, res) {
    try {
      const result = await ideaTaskService.getIdeaTaskStatistics(req.query, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async getIdeaTaskById(req, res) {
    try {
      const result = await ideaTaskService.getIdeaTaskById(req.params.id, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async createIdeaTask(req, res) {
    try {
      const result = await ideaTaskService.createIdeaTask(req.body, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async updateIdeaTask(req, res) {
    try {
      const result = await ideaTaskService.updateIdeaTask(req.params.id, req.body, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async deleteIdeaTask(req, res) {
    try {
      const result = await ideaTaskService.deleteIdeaTask(req.params.id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async assignIdeaTask(req, res) {
    try {
      const result = await ideaTaskService.assignIdeaTask(req.params.id, req.body, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async startWork(req, res) {
    try {
      const result = await ideaTaskService.startWork(req.params.id, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async uploadPsd(req, res) {
    const uploadSingle = upload.single("file");
    uploadSingle(req, res, async (multerErr) => {
      try {
        if (multerErr) {
          if (multerErr.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ message: "File too large (max 1GB)" });
          }
          return res.status(400).json({ message: multerErr.message || "Upload error" });
        }
        const result = await ideaTaskService.uploadPsd(req.params.id, req.file, req.user);
        return res.json(result);
      } catch (error) {
        return res.status(500).json({ error: { message: error.message } });
      }
    });
  }

  async approveTask(req, res) {
    try {
      const result = await ideaTaskService.approveTask(req.params.id, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async rejectTask(req, res) {
    try {
      const { reason } = req.body;
      const result = await ideaTaskService.rejectTask(req.params.id, reason, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async addComment(req, res) {
    try {
      const { text } = req.body;
      const result = await ideaTaskService.addComment(req.params.id, text, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }

  async getIdeaPsdSignedUrl(req, res) {
    try {
      const result = await ideaTaskService.getIdeaPsdSignedUrl(req.params.id, req.query, req.user);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: { message: error.message } });
    }
  }
}

module.exports = new IdeaTaskController();

