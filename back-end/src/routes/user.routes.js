const express = require('express');
const { userController } = require('../controllers');
const { authenticateToken, authorizeRoles } = require('../middlewares/auth.middleware');

const router = express.Router();

router.get('/',
    authenticateToken,
    authorizeRoles('Admin'),
    userController.getAllUsers
);

router.post('/',
    authenticateToken,
    authorizeRoles('Admin'),
    userController.createUser
);

router.get('/:id',
    authenticateToken,
    userController.getUserById
);

module.exports = router;
