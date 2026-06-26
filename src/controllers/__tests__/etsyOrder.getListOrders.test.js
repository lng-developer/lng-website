jest.mock("../../models", () => ({
  EtsyOrder: {
    countDocuments: jest.fn(),
    find: jest.fn(),
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
const controller = require("../etsyOrder.controller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function mockFindLean(rows = []) {
  const chain = {
    populate: jest.fn().mockReturnThis(),
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
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [],
        totalCount: 0,
      })
    );
  });
});
