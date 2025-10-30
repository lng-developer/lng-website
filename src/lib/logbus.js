const MAX_LOGS = 3000;
const store = [];

function append(ev) {
  store.push(ev);
  if (store.length > MAX_LOGS) store.splice(0, store.length - MAX_LOGS);
}

function query({ shopId, machineId, since, limit = 200 }) {
  const s = Number(since || 0);
  const out = [];
  for (let i = store.length - 1; i >= 0; i--) {
    const e = store[i];
    if (s && e.at && e.at < s) break;
    if (shopId && e.shopId !== shopId) continue;
    if (machineId && e.machineId !== machineId) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return out.reverse();
}

module.exports = { append, query };
