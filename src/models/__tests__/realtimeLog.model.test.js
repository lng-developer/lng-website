const RealtimeLog = require("../realtimeLog.model");

test("expires APO realtime logs after 30 days", () => {
  expect(RealtimeLog.schema.indexes()).toContainEqual([
    { ts: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60 },
  ]);
});
