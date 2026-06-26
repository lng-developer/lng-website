jest.mock("../../models", () => ({
  EtsyOrder: {
    countDocuments: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
  },
  vendorProduct: { find: jest.fn() },
  vendor: { find: jest.fn() },
  user: {},
  role: {},
  shop: { find: jest.fn() },
}));

jest.mock("../../models/etsyListing.model", () => ({}));
jest.mock("../../service/cloudflareR2/r2.service", () => ({
  uploadBufferToR2: jest.fn(),
  uploadFilePathToR2: jest.fn(),
}));
jest.mock("../../service/fulfillment", () => ({
  PROVIDERS: [],
  send: jest.fn(),
}));
jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn(),
}));
jest.mock("../../service/etsyTrackingResponse.service", () => ({
  buildEtsyTrackingInfoResponse: jest.fn(() => ({})),
  buildEtsyTrackingSummary: jest.fn(() => ({})),
}));
jest.mock("axios", () => ({}));

const db = require("../../models");
const mongoose = require("mongoose");
const controller = require("../etsyOrder.controller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function mockFindLean(rows = []) {
  const chain = {
    populate: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  db.EtsyOrder.find.mockReturnValue(chain);
  return chain;
}

function mockSelectLean(findMock, rows = []) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  findMock.mockReturnValue(chain);
  return chain;
}

describe("getListOrders", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.EtsyOrder.countDocuments.mockResolvedValue(0);
    db.EtsyOrder.aggregate.mockResolvedValue([{ all: 0 }]);
    mockFindLean([]);
    db.vendorProduct.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
    db.vendor.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  });

  test("filters invalid addresses when invalidAddress=true", async () => {
    const req = {
      query: {
        page: "1",
        limit: "10",
        from: "2026-06-20T00:00:00.000Z",
        to: "2026-06-26T23:59:59.999Z",
        invalidAddress: "true",
      },
    };
    const res = makeRes();

    await controller.getListOrders(req, res);

    expect(db.EtsyOrder.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        "address_validation.isValid": false,
      })
    );
    expect(db.EtsyOrder.find).toHaveBeenCalledWith(
      expect.objectContaining({
        "address_validation.isValid": false,
      })
    );
    expect(db.EtsyOrder.find.mock.results[0].value.select).toHaveBeenCalledWith(expect.stringContaining("orderId"));
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [],
        totalCount: 0,
      })
    );
  });

  test("uses exact orderId search path before broad regex search", async () => {
    const req = {
      query: {
        page: "1",
        limit: "10",
        search: "4094616499",
      },
    };
    const res = makeRes();

    await controller.getListOrders(req, res);

    expect(db.EtsyOrder.countDocuments).toHaveBeenCalledWith({ orderId: "4094616499" });
    expect(db.EtsyOrder.find).toHaveBeenCalledWith({ orderId: "4094616499" });
    expect(db.EtsyOrder.find.mock.results[0].value.select).toHaveBeenCalledWith(expect.stringContaining("vendor_submissions"));
  });

  test("filters orders by vendorId through mapped vendor products", async () => {
    const vendorId = "507f1f77bcf86cd799439011";
    const vendorProductId = new mongoose.Types.ObjectId("507f191e810c19729de860ea");
    mockSelectLean(db.vendorProduct.find, [{ _id: vendorProductId }]);
    const req = {
      query: {
        page: "1",
        limit: "10",
        vendorId,
      },
    };
    const res = makeRes();

    await controller.getListOrders(req, res);

    const vendorProductQuery = db.vendorProduct.find.mock.calls[0][0];
    expect(String(vendorProductQuery.vendor_id)).toBe(vendorId);

    const orderFilter = db.EtsyOrder.countDocuments.mock.calls[0][0];
    expect(orderFilter["items.cost_breakdown.vendorProductId"].$in.map(String)).toEqual(
      expect.arrayContaining([String(vendorProductId)])
    );
  });

  test("statistics applies vendorId to the base match", async () => {
    const vendorId = "507f1f77bcf86cd799439011";
    const vendorProductId = new mongoose.Types.ObjectId("507f191e810c19729de860ea");
    mockSelectLean(db.vendorProduct.find, [{ _id: vendorProductId }]);
    const req = {
      query: {
        vendorId,
      },
    };
    const res = makeRes();

    await controller.getEtsyOrderStatistics(req, res);

    const aggregatePipeline = db.EtsyOrder.aggregate.mock.calls[0][0];
    expect(aggregatePipeline[0].$match["items.cost_breakdown.vendorProductId"].$in.map(String)).toEqual(
      expect.arrayContaining([String(vendorProductId)])
    );
  });
});
