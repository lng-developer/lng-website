// routes/todoList.routes.js (or routes/trello.routes.js)
const express = require("express");
const router = express.Router();

const projectController = require("../controllers/project.controller");
const categoryController = require("../controllers/category.controller");
const issueController = require("../controllers/issue.controller");
const notificationController = require("../controllers/notification.controller");

const { authenticateToken } = require("../middlewares/auth.middleware");

// ======================= Project =======================
router.post("/projects", authenticateToken, projectController.createProject);
router.get("/projects", authenticateToken, projectController.listProjects);
router.get("/projects/:projectId", authenticateToken, projectController.getProjectDetail);
router.patch("/projects/:projectId", authenticateToken, projectController.updateProject);
router.post("/projects/:projectId/archive", authenticateToken, projectController.archiveProject);

// ======================= Category (Columns) =======================
router.get(
    "/projects/:projectId/categories",
    authenticateToken,
    categoryController.listCategories
);  

router.post(
    "/projects/:projectId/categories",
    authenticateToken,
    categoryController.createCategory
);

router.patch(
    "/projects/:projectId/categories/:categoryId",
    authenticateToken,
    categoryController.updateCategory
);

router.post(
    "/projects/:projectId/categories/reorder",
    authenticateToken,
    categoryController.reorderCategories
);

router.post(
    "/projects/:projectId/categories/:categoryId/archive",
    authenticateToken,
    categoryController.archiveCategory
);

// ======================= Issue (Cards) =======================
router.get(
    "/projects/:projectId/board",
    authenticateToken,
    issueController.getBoard
);

router.post(
    "/projects/:projectId/issues",
    authenticateToken,
    issueController.createIssue
);

router.patch(
    "/projects/:projectId/issues/:issueId",
    authenticateToken,
    issueController.updateIssue
);

router.post(
    "/projects/:projectId/issues/:issueId/comments",
    authenticateToken,
    issueController.addComment
);

router.post(
    "/projects/:projectId/issues/:issueId/move",
    authenticateToken,
    issueController.moveIssue
);

router.post(
    "/projects/:projectId/issues/:issueId/archive",
    authenticateToken,
    issueController.archiveIssue
);

// ======================= Notification =======================
router.get(
    "/notifications",
    authenticateToken,
    notificationController.listNotifications
);

router.post(
    "/notifications/:notificationId/read",
    authenticateToken,
    notificationController.markRead
);

router.post(
    "/notifications/read-all",
    authenticateToken,
    notificationController.markAllRead
);

router.post(
    "/notifications/:notificationId/archive",
    authenticateToken,
    notificationController.archiveNotification
);

module.exports = router;
