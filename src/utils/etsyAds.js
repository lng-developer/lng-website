const importTime = (doc) => new Date(
  doc?.lastImportedAt || doc?.updatedAt || doc?.createdAt || 0
).getTime() || 0;

const dedupeEtsyAdsDailySummaries = (docs = []) => {
  const latestByShopDay = new Map();

  for (const doc of docs) {
    const etsyShopId = String(doc?.etsyShopId || "").trim();
    if (!etsyShopId) {
      latestByShopDay.set(Symbol(), doc);
      continue;
    }

    const key = `${new Date(doc.day).toISOString()}|${etsyShopId}`;
    const current = latestByShopDay.get(key);
    if (!current || importTime(doc) > importTime(current)) latestByShopDay.set(key, doc);
  }

  return Array.from(latestByShopDay.values());
};

module.exports = { dedupeEtsyAdsDailySummaries };
