jest.mock("../../models", () => ({
  EtsyOrder: {
    countDocuments: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
  },
  OrderHistory: { find: jest.fn() },
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

function mockHistoryFind(rows = []) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  db.OrderHistory.find.mockReturnValue(chain);
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

  test("does not aggregate financial totals for regular Etsy order lists", async () => {
    const res = makeRes();

    await controller.getListOrders({ query: { page: "1", limit: "10" } }, res);

    expect(db.EtsyOrder.aggregate).not.toHaveBeenCalled();
  });

  test("includes chronological history for the Etsy order when includeLogs=true", async () => {
    const orderId = new mongoose.Types.ObjectId("507f1f77bcf86cd799439011");
    mockFindLean([{ _id: orderId, orderId: "4105971529", items: [] }]);
    mockHistoryFind([
      { _id: "new", order: orderId, action: "UPDATE_STATUS", createdAt: new Date("2026-08-21T02:00:00.000Z") },
      { _id: "old", order: orderId, action: "UPDATE_ADDRESS", createdAt: new Date("2026-08-21T01:00:00.000Z") },
    ]);
    db.EtsyOrder.countDocuments.mockResolvedValue(1);
    const res = makeRes();

    await controller.getListOrders({ query: { page: "1", limit: "10", includeLogs: "true", logLimit: "5" } }, res);

    expect(db.OrderHistory.find).toHaveBeenCalledWith({ order: { $in: [orderId] } });
    expect(res.json.mock.calls[0][0].data[0].history.map((event) => event.action)).toEqual([
      "UPDATE_ADDRESS",
      "UPDATE_STATUS",
    ]);
  });

  test("returns the seller stored on each Etsy item", async () => {
    mockFindLean([{
      _id: new mongoose.Types.ObjectId("507f1f77bcf86cd799439011"),
      orderId: "4134593115",
      items: [{
        transactionId: "5164584376",
        sku: "J2512-NK-200726-H3",
        seller: { sellerId: new mongoose.Types.ObjectId("68b93ed3f02eed8dec002eee"), sellerCode: "J2512" },
      }],
    }]);
    db.EtsyOrder.countDocuments.mockResolvedValue(1);
    const res = makeRes();

    await controller.getListOrders({ query: { page: "1", limit: "10" } }, res);

    expect(res.json.mock.calls[0][0].data[0].items[0].seller).toEqual(expect.objectContaining({
      sellerCode: "J2512",
    }));
  });

  test("returns paged financial fields and a full filtered summary for the Etsy cost report", async () => {
    mockFindLean([{
      _id: new mongoose.Types.ObjectId("507f1f77bcf86cd799439011"),
      orderId: "4148263696",
      base_cost: 33.18,
      totals: { orderTotal: 83.51 },
      items: [{ transactionId: "5185730497", sku: "J2609-NK-071526-11", quantity: 1, unitPrice: 100.95 }],
    }]);
    db.EtsyOrder.countDocuments.mockResolvedValue(286);
    db.EtsyOrder.aggregate.mockResolvedValue([{ orders: 286, revenue: 16010.86, baseCost: 6604.17 }]);
    const res = makeRes();

    await controller.getListOrders({ query: { page: "1", limit: "10", includeCostSummary: "true" } }, res);

    const payload = res.json.mock.calls[0][0];
    expect(db.EtsyOrder.find.mock.results[0].value.select).toHaveBeenCalledWith(expect.stringContaining("totals"));
    expect(payload.summary).toEqual({
      orders: 286,
      revenue: 16010.86,
      baseCost: 6604.17,
      fee: 3362.28,
      profit: 6044.41,
    });
    expect(payload.data[0]).toEqual(expect.objectContaining({
      revenue: 83.51,
      fee: 17.54,
      profit: 32.79,
    }));
    expect(payload.data[0].items[0]).toEqual(expect.objectContaining({ price: 100.95 }));
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

  test("filters unchecked addresses when addressUnchecked=true", async () => {
    const req = {
      query: {
        page: "1",
        limit: "10",
        addressUnchecked: "true",
      },
    };
    const res = makeRes();

    await controller.getListOrders(req, res);

    const orderFilter = db.EtsyOrder.countDocuments.mock.calls[0][0];
    expect(orderFilter).toEqual(expect.objectContaining({
      "address_validation.isValid": null,
      status: { $nin: ["Cancelled", "Canceled"] },
    }));
    expect(db.EtsyOrder.find).toHaveBeenCalledWith(orderFilter);
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

  test("statistics includes addressUnchecked facet", async () => {
    const res = makeRes();

    await controller.getEtsyOrderStatistics({ query: {} }, res);

    const facet = db.EtsyOrder.aggregate.mock.calls[0][0][1].$facet;
    expect(facet.addressUnchecked).toEqual(expect.any(Array));
    expect(JSON.stringify(facet.addressUnchecked)).toContain("address_validation.isValid");
  });
});
