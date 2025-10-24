// src/lib/presence.js
const TTL_MS = 30_000; // hết hạn nếu > 30s không heartbeat

class Presence {
  constructor() {
    this.map = new Map(); // machineId -> info
  }

  online({ shopId, machineId, label, version, socketId, ua, ip }) {
    const now = Date.now();
    this.map.set(machineId, {
      shopId,
      label: label || `Client ${machineId}`,
      version: version || "",
      socketId: socketId || null,
      ua: ua || "",
      ip: ip || "",
      lastSeen: now,
    });
  }

  heartbeat(machineId, patch = {}) {
    const m = this.map.get(machineId);
    if (m) {
      Object.assign(m, patch);
      m.lastSeen = Date.now();
    }
  }

  offline(machineId) {
    this.map.delete(machineId);
  }

  isOnline(machineId) {
    const m = this.map.get(machineId);
    return !!m && Date.now() - m.lastSeen <= TTL_MS;
  }

  snapshot() {
    const now = Date.now();
    const out = [];
    for (const [machineId, v] of this.map) {
      if (now - v.lastSeen > TTL_MS) {
        this.map.delete(machineId);
        continue;
      }
      out.push({
        machineId,
        shopId: v.shopId,
        label: v.label,
        version: v.version,
        socketId: v.socketId,
        ua: v.ua,
        ip: v.ip,
        lastSeen: v.lastSeen,
        status: "online",
      });
    }
    // sắp xếp theo lastSeen desc
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out;
  }
}

module.exports = new Presence();
