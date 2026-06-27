jest.mock("../../models", () => ({
  OrderLifecycleEvent: {
    countDocuments: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
  },
}));

const db = require("../../models");
const controller = require("../orderLifecycle.controller");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function mockFind(rows = []) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  db.OrderLifecycleEvent.find.mockReturnValue(chain);
  return chain;
}

describe("orderLifecycle.controller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("lists events with filters and pagination", async () => {
    const chain = mockFind([{ orderId: "4099502738" }]);
    db.OrderLifecycleEvent.countDocuments.mockResolvedValue(1);
    const req = {
      query: {
        platform: "etsy",
        orderId: "4099502738",
        stage: "AUTO_COST",
        status: "failed",
        eventType: "AUTO_COST_FAILED",
        from: "2026-06-26T00:00:00.000Z",
        to: "2026-06-27T00:00:00.000Z",
        page: "2",
        limit: "10",
      },
    };
    const res = makeRes();

    await controller.getEvents(req, res);

    expect(db.OrderLifecycleEvent.find).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      orderId: "4099502738",
      stage: "AUTO_COST",
      status: "failed",
      eventType: "AUTO_COST_FAILED",
      occurredAt: {
        $gte: new Date("2026-06-26T00:00:00.000Z"),
        $lte: new Date("2026-06-27T00:00:00.000Z"),
      },
    }));
    expect(chain.sort).toHaveBeenCalledWith({ occurredAt: -1 });
    expect(chain.skip).toHaveBeenCalledWith(10);
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: [{ orderId: "4099502738" }],
      pagination: expect.objectContaining({ page: 2, limit: 10, total: 1 }),
    }));
  });

  test("rejects deep offset pagination", async () => {
    const req = { query: { page: "51", limit: "50" } };
    const res = makeRes();

    await controller.getEvents(req, res);

    expect(db.OrderLifecycleEvent.find).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: "Order lifecycle page is too deep; narrow filters or use page <= 50",
    });
  });

  test("rejects date ranges over 30 days unless orderId is provided", async () => {
    const req = {
      query: {
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-03-01T00:00:00.000Z",
      },
    };
    const res = makeRes();

    await controller.getSummary(req, res);

    expect(db.OrderLifecycleEvent.aggregate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: "Order lifecycle date range cannot exceed 30 days without orderId",
    });
  });

  test("returns summary grouped by stage and event type", async () => {
    db.OrderLifecycleEvent.aggregate
      .mockResolvedValueOnce([{ _id: null, total: 4, failed: 2, success: 1, warning: 1 }])
      .mockResolvedValueOnce([{ _id: "AUTO_COST", total: 3, failed: 2 }])
      .mockResolvedValueOnce([{ _id: "AUTO_COST_FAILED", total: 2, failed: 2 }]);
    mockFind([{ orderId: "4099502738", platform: "etsy", stage: "AUTO_COST", eventType: "AUTO_COST_FAILED", reason: "No matching vendor product" }]);

    const req = { query: { platform: "etsy" } };
    const res = makeRes();

    await controller.getSummary(req, res);

    expect(db.OrderLifecycleEvent.aggregate).toHaveBeenCalledTimes(3);
    expect(db.OrderLifecycleEvent.find).toHaveBeenCalledWith(expect.objectContaining({
      platform: "etsy",
      status: "failed",
    }));
    expect(res.json).toHaveBeenCalledWith({
      totals: { total: 4, failed: 2, success: 1, warning: 1 },
      byStage: [{ stage: "AUTO_COST", total: 3, failed: 2 }],
      byEventType: [{ eventType: "AUTO_COST_FAILED", total: 2, failed: 2 }],
      recentFailures: [{ orderId: "4099502738", platform: "etsy", stage: "AUTO_COST", eventType: "AUTO_COST_FAILED", reason: "No matching vendor product" }],
    });
  });
});
