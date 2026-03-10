const express = require("express");
const router = express.Router();
const ideaTaskController = require("../controllers/ideaTask.controller");
const { authenticateToken } = require("../../../middleware/auth.middleware");

router.use(authenticateToken);

router.get("/", ideaTaskController.getAllIdeaTasks);
router.get("/stats", ideaTaskController.getIdeaTaskStatistics);
router.get("/:id", ideaTaskController.getIdeaTaskById);
router.post("/", ideaTaskController.createIdeaTask);
router.put("/:id", ideaTaskController.updateIdeaTask);
router.delete("/:id", ideaTaskController.deleteIdeaTask);

router.post("/:id/assign", ideaTaskController.assignIdeaTask);
router.post("/:id/start", ideaTaskController.startWork);
router.post("/:id/upload", ideaTaskController.uploadPsd);
router.post("/:id/approve", ideaTaskController.approveTask);
router.post("/:id/reject", ideaTaskController.rejectTask);
router.post("/:id/comment", ideaTaskController.addComment);
router.get("/:id/psd-url", ideaTaskController.getIdeaPsdSignedUrl);

module.exports = router;

