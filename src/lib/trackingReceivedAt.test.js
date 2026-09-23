const { resolveTrackingReceivedAt } = require("./trackingReceivedAt");

test("records only the first time a real tracking number arrives", () => {
  const receivedAt = new Date("2026-09-21T08:00:00.000Z");
  expect(resolveTrackingReceivedAt(null, "", "4PX123", receivedAt)).toBe(receivedAt);
  expect(resolveTrackingReceivedAt(receivedAt, "4PX123", "4PX123")).toBe(receivedAt);
  expect(resolveTrackingReceivedAt(null, "---", "")).toBeNull();
});
