describe("viettelPostTrackingScheduler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv, VIETTELPOST_TRACKING_POLL_ENABLED: "true" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("runs the bounded Viettel tracking sync when explicitly enabled", async () => {
    const runViettelPostTrackingSync = jest.fn().mockResolvedValue({ updated: 3 });
    jest.doMock("../viettelPostTrackingSync.service", () => ({ runViettelPostTrackingSync }));

    const scheduler = require("../viettelPostTrackingScheduler");

    await expect(scheduler.runOnce()).resolves.toEqual({ updated: 3 });
    expect(runViettelPostTrackingSync).toHaveBeenCalledWith({ sinceDays: 7, max: 1000, apply: true });
  });
});
