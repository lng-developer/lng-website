jest.mock("../../utils/cloudinary", () => ({
  uploader: { upload_stream: jest.fn() },
}));

jest.mock("../../service/cloudflareR2/r2.service", () => ({
  uploadBufferToR2: jest.fn(),
}));

jest.mock("../../service/fulfillment", () => ({
  PROVIDERS: [],
  send: jest.fn(),
}));

jest.mock("../../service/pointsService", () => ({
  addPointsFromTask: jest.fn(),
  addPenaltyForScaleReject: jest.fn(),
}));

jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn(),
}));

jest.mock("../../models", () => ({
  orderCustomProduct: { aggregate: jest.fn() },
  vendorProduct: { find: jest.fn() },
  listing: { find: jest.fn() },
  user: {},
  Team: {},
  shop: {},
  role: {},
}));

const db = require("../../models");
const controller = require("../scale.controller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(query) {
  return {
    query,
    user: {
      role: "Admin",
      userId: "507f1f77bcf86cd799439011",
    },
  };
}

describe("getScaleList query shape", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.orderCustomProduct.aggregate
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);
  });

  test("matches scale status before lookup stages", async () => {
    const res = makeRes();

    await controller.getScaleList(makeReq({ scale_status: "Ready" }), res);

    const pipeline = db.orderCustomProduct.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({
      $match: expect.objectContaining({
        scale_overall_status: { $in: ["Ready"] },
      }),
    });
    expect(pipeline.findIndex((stage) => stage.$lookup)).toBeGreaterThan(0);
  });

  test("matches Pending item status early and still filters pending items", async () => {
    const res = makeRes();

    await controller.getScaleList(makeReq({ scale_status: "Pending" }), res);

    const pipeline = db.orderCustomProduct.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({
      $match: expect.objectContaining({
        scale_overall_status: { $in: ["Pending"] },
        "items.scale_status": "Pending",
      }),
    });
    expect(JSON.stringify(pipeline)).toContain("$$it.scale_status");
  });

  test("skips available PSD lookup when status cannot include Need Scale", async () => {
    const res = makeRes();

    await controller.getScaleList(makeReq({ scale_status: "Ready" }), res);

    const pipeline = db.orderCustomProduct.aggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).not.toContain("availablePsdListings");
  });

  test("keeps available PSD lookup for Need Scale", async () => {
    const res = makeRes();

    await controller.getScaleList(makeReq({ scale_status: "Need Scale" }), res);

    const pipeline = db.orderCustomProduct.aggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).toContain("availablePsdListings");
  });

  test("does not hide a searched Need Scale order for an unavailable PSD", async () => {
    const res = makeRes();

    await controller.getScaleList(
      makeReq({ scale_status: "Need Scale", search: "B0HC1RTX2P" }),
      res
    );

    const pipeline = db.orderCustomProduct.aggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).not.toContain("availablePsdListings");
  });

  test("searches ASIN and seller fields in one OR condition", async () => {
    const res = makeRes();

    await controller.getScaleList(makeReq({ search: "B0HC1RTX2P" }), res);

    const pipeline = db.orderCustomProduct.aggregate.mock.calls[0][0];
    const searchStages = pipeline.filter((stage) => stage.$match?.$or);
    expect(searchStages).toHaveLength(1);
    expect(JSON.stringify(searchStages[0])).toContain("items.asin");
    expect(JSON.stringify(searchStages[0])).toContain("seller.full_name");
  });

  test("matches sellerId and CS unassigned filters early", async () => {
    const res = makeRes();

    await controller.getScaleList(
      makeReq({
        sellerId: "507f1f77bcf86cd799439012",
        cs_unassigned: "true",
      }),
      res
    );

    const pipeline = db.orderCustomProduct.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({
        sellerId: expect.any(Object),
        $or: [
          { csAssigneeId: { $exists: false } },
          { csAssigneeId: null },
          { cs_assignment_status: "Unassigned" },
        ],
      })
    );
  });
});
