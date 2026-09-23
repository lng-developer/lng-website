describe("presence", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("keeps the last heartbeat when a client disconnects", () => {
    const presence = require("./presence");
    presence.online({ machineId: "machine-1", shopId: "shop-1", socketId: "socket-1" });
    const beforeDisconnect = presence.getByMachine("machine-1");

    presence.offline("machine-1");
    const offline = presence.getByMachine("machine-1");

    expect(offline.status).toBe("offline");
    expect(offline.lastSeen).toBe(beforeDisconnect.lastSeen);
    expect(offline.disconnectedAt).toBeGreaterThanOrEqual(beforeDisconnect.lastSeen);
  });

  test("does not take a newer socket offline", () => {
    const presence = require("./presence");
    presence.online({ machineId: "machine-1", shopId: "shop-1", socketId: "socket-2" });
    presence.offline("machine-1", "socket-1");

    expect(presence.getByMachine("machine-1").status).toBe("online");
  });
});
