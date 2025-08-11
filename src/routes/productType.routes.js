const router = require('express').Router();
const c = require('../controllers/productType.controller');

router.get('/', c.getGroups);
router.post('/', c.createGroup);
router.put('/:groupId', c.updateGroup);
router.delete('/:groupId', c.deleteGroup);

router.post('/:groupId/items', c.addItem);
router.put('/:groupId/items/:itemId', c.updateItem);
router.delete('/:groupId/items/:itemId', c.deleteItem);

// Reorder thủ công các item trong group
router.put('/:groupId/reorder', c.reorderItems);

module.exports = router;
