const MAX_LOGS = 1000; // tổng log giữ lại toàn hệ thống
const MAX_PER_CLIENT = 250; // tối đa cho mỗi machineId

const logs = []; // danh sách mới nhất ở cuối
const byClient = new Map(); // machineId -> array
const byShop = new Map(); // shopId -> array

function _pushToMap(map, key, item, cap) {
  if (!key) return;
  const arr = map.get(key) || [];
  arr.push(item);
  while (arr.length > cap) arr.shift();
  map.set(key, arr);
}

function append(entry) {
  // entry: { at, shopId, machineId, type, message, ... }
  logs.push(entry);
  while (logs.length > MAX_LOGS) logs.shift();

  _pushToMap(byClient, entry.machineId, entry, MAX_PER_CLIENT);
  _pushToMap(byShop, entry.shopId, entry, MAX_LOGS);
}

function query({ shopId, machineId, since = 0, limit = 100 }) {
  let source = logs;
  if (machineId && byClient.has(machineId)) source = byClient.get(machineId);
  else if (shopId && byShop.has(shopId)) source = byShop.get(shopId);

  const out = source.filter((x) => !since || x.at > Number(since));
  if (out.length > limit) return out.slice(out.length - limit);
  return out;
}

// tổng hợp nhanh theo khoảng thời gian
function summary({ shopId, machineId, from = 0, to = Date.now() }) {
  const list = query({ shopId, machineId, since: from, limit: 10_000 }).filter(
    (x) => x.at <= to
  );

  const agg = { total: list.length, byType: {}, firstAt: null, lastAt: null };
  for (const it of list) {
    agg.byType[it.type] = (agg.byType[it.type] || 0) + 1;
    if (!agg.firstAt || it.at < agg.firstAt) agg.firstAt = it.at;
    if (!agg.lastAt || it.at > agg.lastAt) agg.lastAt = it.at;
  }
  return agg;
}

module.exports = { append, query, summary };
