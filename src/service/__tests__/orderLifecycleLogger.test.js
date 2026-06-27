jest.mock("../../models", () => ({
  OrderLifecycleEvent: {
    create: jest.fn(),
  },
}));

jest.mock("../../helper/logger", () => ({
  warn: jest.fn(),
}));

const db = require("../../models");
const logger = require("../../helper/logger");
const { logOrderLifecycleEvent } = require("../orderLifecycleLogger");

describe("logOrderLifecycleEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("creates event with safe defaults", async () => {
    db.OrderLifecycleEvent.create.mockResolvedValue({});

    await logOrderLifecycleEvent({
      platform: "etsy",
      orderId: "4099502738",
      stage: "AUTO_COST",
      eventType: "AUTO_COST_SUCCESS",
      status: "success",
      metadata: {
        base_cost: 12.75,
        rawOrder: { ignored: true },
        imageUrl: "https://example.com/image.jpg",
      },
    });

    expect(db.OrderLifecycleEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: "4099502738",
      stage: "AUTO_COST",
      eventType: "AUTO_COST_SUCCESS",
      status: "success",
      actorType: "system",
      entityType: "order",
      metadata: { base_cost: 12.75 },
    }));
    expect(db.OrderLifecycleEvent.create.mock.calls[0][0].occurredAt).toBeInstanceOf(Date);
  });

  test("does not throw when event write fails", async () => {
    db.OrderLifecycleEvent.create.mockRejectedValue(new Error("mongo down"));

    await expect(logOrderLifecycleEvent({
      platform: "etsy",
      orderId: "4099502738",
      stage: "AUTO_COST",
      eventType: "AUTO_COST_FAILED",
      status: "failed",
    })).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Order lifecycle event write failed"));
  });
});
