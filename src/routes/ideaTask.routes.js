const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');
const { ideaTaskController } = require('../controllers');

// TẤT CẢ route đều cần đăng nhập
router.use(authenticateToken);

/**
 * Lưu ý:
 * - Các route tĩnh (/statistic, /, …) phải đặt TRƯỚC /:id
 */

// ===== STATISTICS =====
router.get(
    '/stats',
    authorizeRoles('Admin', 'Design Leader', 'Designer', 'User', 'Seller'),
    ideaTaskController.getIdeaTaskStatistics
);

// ===== LIST (PHÂN TRANG + METADATA) =====
router.get(
    '/',
    authorizeRoles('Admin', 'Design Leader', 'Designer', 'User', 'Seller'),
    ideaTaskController.getAllIdeaTasks
);

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

// ===== CRUD =====
// ⚠️ để sau cùng để không nuốt các route tĩnh
router.get('/:id', ideaTaskController.getIdeaTaskById);
router.post('/', ideaTaskController.createIdeaTask);
router.put('/:id', ideaTaskController.updateIdeaTask);
router.delete('/:id', authorizeRoles('Admin', 'Design Leader'), ideaTaskController.deleteIdeaTask);
router.get('/idea-tasks/:id/psd', ideaTaskController.getIdeaPsdSignedUrl);
module.exports = router;
