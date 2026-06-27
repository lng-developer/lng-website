const OrderLifecycleEvent = require("../orderLifecycleEvent.model");

describe("OrderLifecycleEvent model", () => {
  test("keeps lifecycle events for 180 days", () => {
    const ttlIndex = OrderLifecycleEvent.schema
      .indexes()
      .find(([keys, options]) => keys.occurredAt === 1 && options.expireAfterSeconds === 180 * 24 * 60 * 60);

    expect(ttlIndex).toBeTruthy();
  });
});
