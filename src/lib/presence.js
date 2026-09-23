// lib/presence.js
const map = new Map(); // machineId -> {shopId, machineId, socketId, lastSeen, ...}

function online(info) {
  const now = Date.now();
  map.set(info.machineId, { ...info, connectedAt: now, lastSeen: now, status: "online" });
}

function heartbeat(machineId, patch = {}) {
  const cur = map.get(machineId);
  if (!cur) return;
  map.set(machineId, {
    ...cur,
    ...patch,
    lastSeen: Date.now(),
    status: "online",
  });
}

function offline(machineId, socketId) {
  const cur = map.get(machineId);
  if (!cur || (socketId && cur.socketId !== socketId)) return;
  map.set(machineId, {
    ...cur,
    disconnectedAt: Date.now(),
    status: "offline",
    socketId: null,
  });
}

function updateStats(machineId, stats = {}) {
  const cur = map.get(machineId);
  if (!cur) return;
  map.set(machineId, {
    ...cur,
    stats: {
      ...cur.stats,
      ...stats
    },
    lastSeen: Date.now(),
  });
}

function snapshot() {
  return Array.from(map.values());
}

function getByMachine(machineId) {
  return map.get(machineId) || null;
}

function findBy({ shopId, machineId }) {
  if (machineId) return getByMachine(machineId);
  for (const v of map.values()) if (!shopId || v.shopId === shopId) return v;
  return null;
}

module.exports = { online, heartbeat, offline, updateStats, snapshot, getByMachine, findBy };
