const { v4: uuidv4 } = require("uuid");
const path = require("path");
const INGEST_TOKEN = process.env.INGEST_TOKEN || "lng_2025";
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const fs = require("fs");

// ========= tiny utils =========
function ymd(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function sanitizeName(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .slice(0, 120);
}
function saveBufferFile(dir, filename, buf) {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, buf);
  return fp;
}
function saveTextFile(dir, filename, text) {
  return saveBufferFile(dir, filename, Buffer.from(text, "utf8"));
}

// ========= auth helper (token) =========
function assertAuth(req) {
  const headerToken = req.headers["x-access-token"];
  const queryToken = req.query?.token;
  const ok =
    !!INGEST_TOKEN &&
    (headerToken === INGEST_TOKEN || queryToken === INGEST_TOKEN);
  if (!ok) {
    const err = new Error("unauthorized");
    err.status = 401;
    throw err;
  }
}

// ========= HANDLERS =========

// Import NEW Orders
const importOrders = async (req, res) => {
  try {
    assertAuth(req);
    const shopId = sanitizeName(req.body.shopId || "unknown");
    const today = ymd();

    const file = req.files?.[0];
    if (!file)
      return res.status(400).json({ ok: false, message: "file required" });

    const origName = sanitizeName(
      file.originalname || `import-${uuidv4()}.txt`
    );
    const dir = path.join(DATA_DIR, shopId, "orders_new", today);
    const savedPath = saveBufferFile(dir, origName, file.buffer);

    return res.json({
      ok: true,
      type: "importOrders",
      file: path.relative(process.cwd(), savedPath),
      size: file.size,
    });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, message: e.message || "error" });
  }
};

// Report ALL Orders
const reportOrders = async (req, res) => {
  try {
    assertAuth(req);
    const shopId = sanitizeName(req.body.shopId || "unknown");
    const today = ymd();

    const file = req.files?.[0];
    if (!file)
      return res.status(400).json({ ok: false, message: "file required" });

    const origName = sanitizeName(
      file.originalname || `report-${uuidv4()}.txt`
    );
    const dir = path.join(DATA_DIR, shopId, "orders_all", today);
    const savedPath = saveBufferFile(dir, origName, file.buffer);

    return res.json({
      ok: true,
      type: "reportOrders",
      file: path.relative(process.cwd(), savedPath),
      size: file.size,
    });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, message: e.message || "error" });
  }
};

// Ads Spend
const adsSpend = async (req, res) => {
  try {
    assertAuth(req);
    const shopId = sanitizeName(req.body.shopId || "unknown");
    const today = ymd();

    const file = req.files?.[0];
    if (!file)
      return res.status(400).json({ ok: false, message: "file required" });

    const origName = sanitizeName(file.originalname || `ads-${uuidv4()}.tsv`);
    const dir = path.join(DATA_DIR, shopId, "ads_spend", today);
    const savedPath = saveBufferFile(dir, origName, file.buffer);

    return res.json({
      ok: true,
      type: "adsSpend",
      file: path.relative(process.cwd(), savedPath),
      size: file.size,
    });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, message: e.message || "error" });
  }
};

module.exports = { importOrders, reportOrders, adsSpend };
