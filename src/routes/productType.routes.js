const router = require('express').Router();
const c = require('../controllers/productType.controller');
const { authenticateToken } = require('../middlewares/auth.middleware');

router.get('/', authenticateToken, c.getGroups);
router.post('/', authenticateToken, c.createGroup);
router.put('/:groupId', authenticateToken, c.updateGroup);
router.delete('/:groupId', authenticateToken, c.deleteGroup);

router.post('/:groupId/items', authenticateToken, c.addItem);
router.put('/:groupId/items/:itemId', authenticateToken, c.updateItem);
router.delete('/:groupId/items/:itemId', authenticateToken, c.deleteItem);

// Reorder thủ công các item trong group
router.put('/:groupId/reorder', c.reorderItems);

module.exports = router;
