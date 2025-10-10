const { Server } = require("socket.io");
const { setIo, addLog } = require("../service/realtime.service");

const clients = new Map(); // socket.id -> info

function initSocket(httpServer) {
  const io = new Server(httpServer, {
    path: "/socket",
    cors: { origin: "*" },
    transports: ["websocket", "polling"],
  });
  setIo(io);

  io.on("connection", (socket) => {
    const ip =
      socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
    clients.set(socket.id, {
      socketId: socket.id,
      clientId: null,
      label: null,
      version: null,
      ua: socket.handshake.headers["user-agent"],
      ip,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    });
    addLog("CONNECT", { socketId: socket.id, ip });

    socket.on("HELLO", (info) => {
      const c = clients.get(socket.id);
      if (!c) return;
      c.clientId = info?.clientId || null;
      c.label = info?.label || null;
      c.version = info?.version || null;
      c.lastSeen = Date.now();
      addLog("HELLO", {
        socketId: socket.id,
        clientId: c.clientId,
        label: c.label,
        version: c.version,
      });
    });

    socket.on("ACK", (ack) => {
      const c = clients.get(socket.id);
      if (c) c.lastSeen = Date.now();
      addLog("ACK", {
        socketId: socket.id,
        clientId: c?.clientId,
        label: c?.label,
        jobId: ack?.jobId,
      });
    });

    socket.on("STATUS", (st) => {
      const c = clients.get(socket.id);
      if (c) c.lastSeen = Date.now();
      addLog("STATUS", {
        socketId: socket.id,
        clientId: c?.clientId,
        label: c?.label,
        ...st,
      });
    });

    socket.on("disconnect", (reason) => {
      addLog("DISCONNECT", { socketId: socket.id, reason });
      clients.delete(socket.id);
    });
  });

  return io;
}

function getOnlineClients() {
  return clients;
}

module.exports = { initSocket, getOnlineClients };
