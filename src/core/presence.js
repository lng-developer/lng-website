// lib/presence.js
const map = new Map(); // machineId -> {shopId, machineId, socketId, lastSeen, ...}

function online(info) {
  map.set(info.machineId, { ...info, lastSeen: Date.now(), status: "online" });
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
function offline(machineId) {
  const cur = map.get(machineId);
  if (!cur) return;
  map.set(machineId, {
    ...cur,
    lastSeen: Date.now(),
    status: "offline",
    socketId: null,
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

module.exports = { online, heartbeat, offline, snapshot, getByMachine, findBy };
