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
      merchantId: null,
      marketplaceId: null,
      customer_infor: null,
      status: "New",
      scale_overall_status: "Failed",
      purchase_date: new Date("2026-05-14T00:00:00.000Z"),
      shipping_type: undefined,
      fulfillment_portal_submission: { sent: false, attempt_count: 1 },
      items: [
        {
          orderItemId: "ITEM-1",
          sku: "SKU-1",
          quantity: 1,
          tracking_info: { status: "New" },
        },
        {
          orderItemId: "ITEM-2",
          sku: "SKU-2",
          quantity: 1,
          tracking_info: { status: "Canceled" },
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

    const sentPayload = axios.post.mock.calls[0][1];
    expect(axios.post).toHaveBeenCalledWith(
      "https://fulfillment.example/api/orders",
      expect.objectContaining({
        data: [
          expect.objectContaining({
            orderId: "ORDER-1",
            customer_infor: expect.any(Object),
            status: "Fulfilled",
            purchase_date: "2026-05-14T00:00:00.000Z",
            shipping_type: "Standard",
            items: [
              expect.objectContaining({
                orderItemId: "ITEM-1",
              }),
              expect.objectContaining({
                orderItemId: "ITEM-2",
              }),
            ],
          }),
        ],
      }),
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "test-key",
        },
        timeout: 30000,
      })
    );
    expect(Array.isArray(sentPayload.data)).toBe(true);
    expect(order.scale_overall_status).toBe("Sent");
    expect(order.status).toBe("Fulfilled");
    expect(order.items[0].tracking_info.status).toBe("Fulfilled");
    expect(order.items[1].tracking_info.status).toBe("Canceled");
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

  test("rejects payload before calling fulfillment when an item orderItemId is missing", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: "ORDER-2",
      status: "New",
      scale_overall_status: "Failed",
      fulfillment_portal_submission: { sent: false, attempt_count: 0 },
      items: [{ orderItemId: "", sku: "SKU-1", quantity: 1 }],
      save,
    };
    mockFindChain([order]);

    const req = {
      body: { orderIds: ["ORDER-2"] },
      user: { role: "Admin", _id: "user-1" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.sendFailedOrdersToFulfillment(req, res);

    expect(axios.post).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      message: "Invalid fulfillment payload",
      errors: [
        {
          field: "data[0].items[0].orderItemId",
          message: "orderItemId is required",
        },
      ],
    });
  });

  test("persists failed submission details when fulfillment returns an error", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: "ORDER-3",
      status: "New",
      scale_overall_status: "Failed",
      fulfillment_portal_submission: { sent: false, attempt_count: 2 },
      items: [{ orderItemId: "ITEM-1", sku: "SKU-1", quantity: 1 }],
      save,
    };
    mockFindChain([order]);
    axios.post.mockRejectedValue({
      response: {
        status: 502,
        data: { message: "Fulfillment unavailable" },
      },
    });

    const req = {
      body: { orderIds: ["ORDER-3"] },
      user: { role: "Admin", _id: "user-1" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.sendFailedOrdersToFulfillment(req, res);

    expect(order.fulfillment_portal_submission.sent).toBe(false);
    expect(order.fulfillment_portal_submission.attempt_count).toBe(3);
    expect(order.fulfillment_portal_submission.last_response).toEqual(
      expect.objectContaining({
        error: { message: "Fulfillment unavailable" },
        at: expect.any(Date),
      })
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      message: "Failed to send orders to fulfillment",
      error: { message: "Fulfillment unavailable" },
    });
  });
});

describe("pushPlatformOrders", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...oldEnv,
      FULFILLMENT_API_BASE_URL: "https://platform.example",
      FULFILLMENT_TENANT_API_KEY: "tenant-key",
      FULFILLMENT_API_TIMEOUT_MS: "30000",
    };
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test("pushes selected DB orders to Fulfillment Platform without mutating portal orders", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: "112-0745906-0345025-R1",
      status: "New",
      scale_overall_status: "Ready",
      customer_infor: { name: "Jane Buyer" },
      items: [
        {
          orderItemId: "ITEM-1",
          sku: "SKU-1",
          fulfillment_file: new Map([["front", "https://cdn.example/front.png"]]),
          tracking_info: { status: "New", tracking: "" },
        },
      ],
      save,
    };
    mockFindChain([order]);
    axios.post.mockResolvedValue({
      data: {
        success: true,
        received: 1,
        inserted: 1,
        updated: 0,
        skipped: 0,
        errorsCount: 0,
        errors: [],
        orders: [],
        internalDebug: "not returned unless whitelisted",
      },
    });

    const req = {
      body: { orderIds: ["112-0745906-0345025-R1"] },
      user: { role: "Admin", _id: "user-1" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.pushPlatformOrders(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      "https://platform.example/api/portal/orders",
      {
        data: [
          expect.objectContaining({
            orderId: "112-0745906-0345025-R1",
            status: "New",
            scale_overall_status: "Ready",
            items: [
              expect.objectContaining({
                orderItemId: "ITEM-1",
                fulfillment_file: { front: "https://cdn.example/front.png" },
              }),
            ],
          }),
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tenant-key",
        },
        timeout: 30000,
      }
    );
    expect(order.status).toBe("New");
    expect(order.scale_overall_status).toBe("Ready");
    expect(order.items[0].tracking_info.status).toBe("New");
    expect(save).not.toHaveBeenCalled();
    expect(logOrderHistory).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      message: "Pushed orders to Fulfillment Platform",
      attemptedCount: 1,
      fulfillment: {
        success: true,
        received: 1,
        inserted: 1,
        updated: 0,
        skipped: 0,
        errorsCount: 0,
        errors: [],
        orders: [],
      },
    });
  });

  test("does not save or write order history when Fulfillment Platform rejects the push", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const order = {
      orderId: "ORDER-REJECTED",
      status: "New",
      scale_overall_status: "Ready",
      items: [{ orderItemId: "ITEM-1" }],
      save,
    };
    mockFindChain([order]);
    axios.post.mockRejectedValue({
      response: {
        status: 409,
        data: {
          success: false,
          received: 1,
          inserted: 0,
          updated: 0,
          skipped: 1,
          errorsCount: 0,
          errors: [],
          orders: [],
          stack: "do not return",
        },
      },
    });

    const req = {
      body: { orderIds: ["ORDER-REJECTED"] },
      user: { role: "Admin", _id: "user-1" },
      ip: "127.0.0.1",
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.pushPlatformOrders(req, res);

    expect(save).not.toHaveBeenCalled();
    expect(logOrderHistory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      message: "Failed to push orders to Fulfillment Platform",
      attemptedCount: 1,
      fulfillment: {
        success: false,
        received: 1,
        inserted: 0,
        updated: 0,
        skipped: 1,
        errorsCount: 0,
        errors: [],
        orders: [],
      },
    });
  });
});
