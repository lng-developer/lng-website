const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');
const { ideaTaskController } = require('../controllers');

// TẤT CẢ route đều cần đăng nhập
router.use(authenticateToken);

// ===== STATISTICS =====
router.get(
    '/statistic',
    authorizeRoles('Admin', 'Design Leader', 'Designer', 'User', 'Seller'),
    ideaTaskController.getIdeaTaskStatistics
);

// ===== LIST (PHÂN TRANG + METADATA) =====
router.get(
    '/',
    authorizeRoles('Admin', 'Design Leader', 'Designer', 'User', 'Seller'),
    ideaTaskController.getAllIdeaTasks
);

// ===== CRUD =====
router.get('/:id', ideaTaskController.getIdeaTaskById);
router.post('/', ideaTaskController.createIdeaTask);
router.put('/:id', ideaTaskController.updateIdeaTask);
router.delete('/:id', authorizeRoles('Admin', 'Design Leader'), ideaTaskController.deleteIdeaTask);

// ===== FLOW ACTIONS =====
router.post(
    '/:id/assign',
    authorizeRoles('Admin', 'Design Leader'),
    ideaTaskController.assignIdeaTask
);

router.post('/:id/start', ideaTaskController.startWork);
router.post('/:id/upload-psd', ideaTaskController.uploadPsd);

// >>> Cho phép cả Seller (nhưng controller sẽ kiểm tra đúng "seller chủ idea" mới được duyệt)
router.post(
    '/:id/approve',
    authorizeRoles('Admin', 'Design Leader', 'Seller'),
    ideaTaskController.approveTask
);

router.post(
    '/:id/reject',
    authorizeRoles('Admin', 'Design Leader', 'Seller'),
    ideaTaskController.rejectTask
);

router.post('/:id/comments', ideaTaskController.addComment);

module.exports = router;
