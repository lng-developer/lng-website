describe("fulfillmentTrackingPullScheduler", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      FULFILLMENT_API_BASE_URL: "https://fulfillment.example/",
      FULFILLMENT_TENANT_API_KEY: "tenant-key",
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { attempted: 1 } }),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    delete global.fetch;
  });

  test("pulls tracking through the authenticated Fulfillment endpoint", async () => {
    const scheduler = require("../fulfillmentTrackingPullScheduler");

    await expect(scheduler.runOnce()).resolves.toEqual({ attempted: 1 });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://fulfillment.example/api/portal/tracking/pull",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tenant-key" }),
      }),
    );
  });
});
