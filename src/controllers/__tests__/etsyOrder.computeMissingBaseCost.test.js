jest.mock("../../models", () => ({
  EtsyOrder: {
    find: jest.fn(),
  },
  vendorProduct: {},
  vendorCostCenter: {},
  configCostCenter: {},
  configOptionMapping: {},
  user: {},
  role: {},
  shop: {},
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
const controller = require("../etsyOrder.controller");

function mockFindOrders(rows = []) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };
  chain.limit.mockResolvedValue(rows);
  db.EtsyOrder.find.mockReturnValue(chain);
  return chain;
}

describe("_computeMissingEtsyBaseCosts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("computes Etsy orders that still have no base cost", async () => {
    const orders = [{ orderId: "4098983436" }, { orderId: "4098983437" }];
    const computeOne = jest.fn().mockResolvedValue({});
    const chain = mockFindOrders(orders);

    const result = await controller._computeMissingEtsyBaseCosts({ limit: 25, computeOne });

    expect(db.EtsyOrder.find).toHaveBeenCalledWith({
      $or: [{ base_cost: { $exists: false } }, { base_cost: null }, { base_cost: 0 }],
      status: { $nin: ["Cancelled", "Canceled"] },
      items: { $exists: true, $ne: [] },
    });
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(chain.limit).toHaveBeenCalledWith(25);
    expect(computeOne).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ attempted: 2, computed: 2, failed: 0, errors: [] });
  });

  test("returns batch compute summary from controller endpoint", async () => {
    const orders = [{ orderId: "4098983436" }];
    mockFindOrders(orders);
    const req = { body: { limit: 1 } };
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    await controller.computeMissingBaseCostsForEtsyOrders(req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: "Etsy missing base cost batch computed",
      attempted: 1,
    }));
  });
});
