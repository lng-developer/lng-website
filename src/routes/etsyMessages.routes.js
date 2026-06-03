const express = require("express");
const {
  listEtsyMessageThreads,
  getEtsyMessageThread,
  markEtsyMessageThreadRead,
} = require("../service/etsyMessage.service");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const data = await listEtsyMessageThreads(req.query);
    return res.json(data);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      message: err.message || String(err),
    });
  }
});

router.get("/:threadId", async (req, res) => {
  try {
    const data = await getEtsyMessageThread({
      shopId: req.query.shopId,
      threadId: req.params.threadId,
    });
    return res.status(data.notFound ? 404 : 200).json(data);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      message: err.message || String(err),
    });
  }
});

router.patch("/:threadId/read", async (req, res) => {
  try {
    const body = req.body || {};
    const data = await markEtsyMessageThreadRead({
      shopId: body.shopId || req.query.shopId,
      threadId: req.params.threadId,
      unread: body.unread === true,
    });
    return res.status(data.notFound ? 404 : 200).json(data);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      message: err.message || String(err),
    });
  }
});

module.exports = router;
