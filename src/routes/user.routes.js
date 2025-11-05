const express = require("express");
const { userController } = require("../controllers");
const {
  authenticateToken,
  authorizeRoles,
} = require("../middlewares/auth.middleware");

const router = express.Router();

/**
 * @desc Lấy toàn bộ user (chỉ admin)
 */
router.get(
  "/",
  authenticateToken,
  authorizeRoles("Admin"),
  userController.getAllUsers
);

/**
 * @desc Lấy danh sách seller và admin
 */
router.get(
  "/sellers",
  authenticateToken,
  authorizeRoles("Admin"),
  userController.getAllSeller
);

/**
 * @desc Lấy danh sách designer / lead designer / CS
 */
router.get(
  "/designer",
  authenticateToken,
  authorizeRoles("Admin", "Leader"), // tùy phân quyền
  userController.getAllDesigner
);

/**
 * @desc Tạo mới 1 hoặc nhiều user
 */
router.post(
  "/",
  authenticateToken,
  authorizeRoles("Admin"),
  userController.createUser
);

/**
 * @desc Cập nhật user theo id
 */
router.put(
  "/:id",
  authenticateToken,
  authorizeRoles("Admin"),
  userController.updateUser
);

/**
 * @desc Xóa user theo id
 */
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("Admin"),
  userController.deleteUser
);

/**
 * @desc Lấy thông tin chi tiết 1 user
 */
router.get("/:id", authenticateToken, userController.getUserById);

module.exports = router;
