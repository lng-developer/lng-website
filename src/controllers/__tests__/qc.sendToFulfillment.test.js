jest.mock("axios", () => ({
  post: jest.fn(),
}));

jest.mock("../../models", () => ({
  orderCustomProduct: { find: jest.fn() },
  vendorProduct: {},
  listing: {},
}));

jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn().mockResolvedValue(undefined),
}));

const axios = require("axios");
const db = require("../../models");
const { logOrderHistory } = require("../../service/orderHistoryLogger");
const controller = require("../qc.controller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function mockFindChain(result) {
  const chain = {
    populate: jest.fn(() => chain),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    catch: (reject) => Promise.resolve(result).catch(reject),
  };
  db.orderCustomProduct.find.mockReturnValue(chain);
  return chain;
}

describe("sendFailedOrdersToFulfillment", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...oldEnv,
      FULFILLMENT_PORTAL_URL: "https://fulfillment.example/api/orders",
      FULFILLMENT_PORTAL_API_KEY: "test-key",
      FULFILLMENT_PORTAL_TIMEOUT_MS: "30000",
    };
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test("sends Fulfilled status to portal and marks local order fulfilled", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: "ORDER-1",
      status: "New",
      scale_overall_status: "Failed",
      fulfillment_portal_submission: { sent: false, attempt_count: 1 },
      items: [
        {
          orderItemId: "ITEM-1",
          sku: "SKU-1",
          quantity: 1,
          tracking_info: { status: "New" },
        },
      ],
      save,
    };
    mockFindChain([order]);
    axios.post.mockResolvedValue({ data: { ok: true } });

    const req = {
      body: { orderIds: ["ORDER-1"] },
      user: { role: "Admin", _id: "user-1" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.sendFailedOrdersToFulfillment(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      "https://fulfillment.example/api/orders",
      expect.objectContaining({
        data: [
          expect.objectContaining({
            orderId: "ORDER-1",
            status: "Fulfilled",
          }),
        ],
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-api-key": "test-key" }),
      })
    );
    expect(order.scale_overall_status).toBe("Sent");
    expect(order.status).toBe("Fulfilled");
    expect(order.items[0].tracking_info.status).toBe("Fulfilled");
    expect(save).toHaveBeenCalledTimes(1);
    expect(logOrderHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SEND_TO_FULFILLMENT_PORTAL",
        changes: expect.arrayContaining([
          expect.objectContaining({
            field: "status",
            from: "New",
            to: "Fulfilled",
          }),
        ]),
      })
    );
    expect(res.json).toHaveBeenCalledWith({
      message: "Sent orders to fulfillment successfully",
      sentCount: 1,
      data: { ok: true },
    });
  });
});
