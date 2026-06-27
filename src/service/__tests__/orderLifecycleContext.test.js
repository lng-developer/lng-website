const { buildOrderLifecyclePayload } = require("../orderLifecycleContext");

describe("orderLifecycleContext", () => {
  test("builds common lifecycle payload with user actor and fallback platform", () => {
    const payload = buildOrderLifecyclePayload({
      order: { _id: "oid-1", orderId: "ORDER-1", shopId: "shop-1" },
      req: { user: { _id: "user-1", email: "cs@example.com" } },
      fallbackPlatform: "amazon",
      stage: "ORDER_STATUS",
      eventType: "ORDER_STATUS_CHANGED",
      status: "success",
    });

    expect(payload).toEqual(expect.objectContaining({
      platform: "amazon",
      orderId: "ORDER-1",
      orderObjectId: "oid-1",
      shopId: "shop-1",
      stage: "ORDER_STATUS",
      eventType: "ORDER_STATUS_CHANGED",
      status: "success",
      actorType: "user",
      actorId: "user-1",
      actorName: "cs@example.com",
      entityType: "order",
      entityId: "ORDER-1",
    }));
  });

  test("uses populated shop _id instead of the whole shop object", () => {
    const payload = buildOrderLifecyclePayload({
      order: { orderId: "ORDER-1", shopId: { _id: "shop-1", name: "Shop" } },
      fallbackPlatform: "etsy",
      stage: "IMPORT",
      eventType: "ORDER_IMPORTED",
      status: "success",
    });

    expect(payload.shopId).toBe("shop-1");
  });
});
