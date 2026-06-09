jest.mock("../../models", () => ({
  orderCustomProduct: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
  vendorProduct: {},
  listing: {
    find: jest.fn(),
  },
  user: {
    findById: jest.fn(),
  },
  Team: {},
  shop: {},
  role: {
    findById: jest.fn(),
  },
}));

jest.mock("../../utils/cloudinary", () => ({
  uploader: {
    upload_stream: jest.fn(),
  },
}));

jest.mock("../../service/cloudflareR2/r2.service", () => ({
  uploadBufferToR2: jest.fn(),
}));

jest.mock("../../service/fulfillment", () => ({
  PROVIDERS: [],
  send: jest.fn(),
  sendToVendor: jest.fn(),
}));

jest.mock("../../service/pointsService", () => ({
  addPointsFromTask: jest.fn(),
  addPenaltyForScaleReject: jest.fn(),
}));

jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn().mockResolvedValue(undefined),
}));

const db = require("../../models");
const { logOrderHistory } = require("../../service/orderHistoryLogger");
const scaleController = require("../scale.controller");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function mockFindByIdLean(findByIdMock, row) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(row),
  };
  findByIdMock.mockReturnValue(chain);
  return chain;
}

function mockFindSelectLean(findMock, rows) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  findMock.mockReturnValue(chain);
  return chain;
}

function makeOrder(overrides = {}) {
  return {
    orderId: "ORDER-1",
    scale_overall_status: "Need Scale",
    scaleId: null,
    items: [
      {
        listingId: "333333333333333333333333",
      },
    ],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("scaleController.assignScaleBulk", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns 400 when orderIds is missing", async () => {
    const req = {
      body: {
        scaleUserId: "111111111111111111111111",
      },
    };
    const res = makeRes();

    await scaleController.assignScaleBulk(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: "orderIds must be a non-empty array",
    });
    expect(db.orderCustomProduct.find).not.toHaveBeenCalled();
  });

  test("assigns selected Need Scale PNG tasks to a designer", async () => {
    const scaleUser = {
      _id: "111111111111111111111111",
      full_name: "Scale Designer",
      email: "designer@example.com",
      role_id: "222222222222222222222222",
    };
    const order1 = makeOrder({ orderId: "ORDER-1" });
    const order2 = makeOrder({
      orderId: "ORDER-2",
      items: [{ listingId: "444444444444444444444444" }],
    });

    mockFindByIdLean(db.user.findById, scaleUser);
    mockFindByIdLean(db.role.findById, { name: "Designer" });
    db.orderCustomProduct.find.mockResolvedValue([order1, order2]);
    mockFindSelectLean(db.listing.find, [
      {
        _id: "333333333333333333333333",
        asin_type: "Custom Image",
        psd: { status: "Available" },
      },
      {
        _id: "444444444444444444444444",
        asin_type: "Outline",
        psd: { status: "Available" },
      },
    ]);

    const req = {
      body: {
        orderIds: ["ORDER-1", "ORDER-2"],
        scaleUserId: scaleUser._id,
      },
      user: { userId: "admin-1", role: "Admin" },
      headers: { "user-agent": "jest" },
      ip: "127.0.0.1",
    };
    const res = makeRes();

    await scaleController.assignScaleBulk(req, res);

    expect(db.orderCustomProduct.find).toHaveBeenCalledWith({
      orderId: { $in: ["ORDER-1", "ORDER-2"] },
    });
    expect(order1.scaleId).toBe(scaleUser._id);
    expect(order2.scaleId).toBe(scaleUser._id);
    expect(order1.save).toHaveBeenCalledTimes(1);
    expect(order2.save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledTimes(2);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Bulk scale assignment completed",
        total: 2,
        success: 2,
        failed: 0,
      })
    );
  });

  test("skips orders that are not valid Need Scale PNG tasks", async () => {
    const scaleUser = {
      _id: "111111111111111111111111",
      full_name: "Scale Designer",
      email: "designer@example.com",
      role_id: "222222222222222222222222",
    };
    const sentOrder = makeOrder({
      orderId: "ORDER-SENT",
      scale_overall_status: "Sent",
    });
    const normalListingOrder = makeOrder({
      orderId: "ORDER-NORMAL",
      items: [{ listingId: "555555555555555555555555" }],
    });
    const assignedOrder = makeOrder({
      orderId: "ORDER-ASSIGNED",
      scaleId: "999999999999999999999999",
      items: [{ listingId: "333333333333333333333333" }],
    });

    mockFindByIdLean(db.user.findById, scaleUser);
    mockFindByIdLean(db.role.findById, { name: "Design Leader" });
    db.orderCustomProduct.find.mockResolvedValue([
      sentOrder,
      normalListingOrder,
      assignedOrder,
    ]);
    mockFindSelectLean(db.listing.find, [
      {
        _id: "333333333333333333333333",
        asin_type: "Custom Image",
        psd: { status: "Available" },
      },
      {
        _id: "555555555555555555555555",
        asin_type: "Normal",
        psd: { status: "Available" },
      },
    ]);

    const req = {
      body: {
        orderIds: ["ORDER-SENT", "ORDER-NORMAL", "ORDER-ASSIGNED", "ORDER-MISSING"],
        scaleUserId: scaleUser._id,
      },
      user: { userId: "admin-1", role: "Admin" },
      headers: {},
      ip: "127.0.0.1",
    };
    const res = makeRes();

    await scaleController.assignScaleBulk(req, res);

    expect(sentOrder.save).not.toHaveBeenCalled();
    expect(normalListingOrder.save).not.toHaveBeenCalled();
    expect(assignedOrder.save).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      message: "Bulk scale assignment completed",
      total: 4,
      success: 0,
      failed: 4,
      results: [
        expect.objectContaining({
          orderId: "ORDER-SENT",
          status: "failed",
          error: "Order is not Need Scale",
        }),
        expect.objectContaining({
          orderId: "ORDER-NORMAL",
          status: "failed",
          error: "Order is not a Need Scale PNG task with available PSD",
        }),
        expect.objectContaining({
          orderId: "ORDER-ASSIGNED",
          status: "failed",
          error: "Order already assigned",
        }),
        expect.objectContaining({
          orderId: "ORDER-MISSING",
          status: "failed",
          error: "Order not found",
        }),
      ],
    });
  });

  test("rejects target user when role is not designer or design leader", async () => {
    const scaleUser = {
      _id: "111111111111111111111111",
      full_name: "Customer Service",
      email: "cs@example.com",
      role_id: "222222222222222222222222",
    };

    mockFindByIdLean(db.user.findById, scaleUser);
    mockFindByIdLean(db.role.findById, { name: "Customer Service" });

    const req = {
      body: {
        orderIds: ["ORDER-1"],
        scaleUserId: scaleUser._id,
      },
    };
    const res = makeRes();

    await scaleController.assignScaleBulk(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Selected user must be Designer or Design Leader",
      })
    );
    expect(db.orderCustomProduct.find).not.toHaveBeenCalled();
  });
});
