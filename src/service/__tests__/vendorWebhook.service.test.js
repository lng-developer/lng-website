jest.mock("../../models", () => ({
  EtsyOrder: { findOne: jest.fn() },
  orderCustomProduct: { findOne: jest.fn() },
  vendorProduct: { find: jest.fn() },
  vendor: { find: jest.fn() },
}));

const db = require("../../models");
const vendorWebhookService = require("../vendorWebhook.service");
const crypto = require("crypto");

function mockSelectLean(findMock, rows) {
  const chain = {
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  findMock.mockReturnValue(chain);
  return chain;
}

describe("vendorWebhookService", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...oldEnv };
    delete process.env.ONOS_WEBHOOK_SECRET;
    delete process.env.VENDOR_WEBHOOK_SECRET;
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test("handles Onos webhook and updates Etsy order tracking", async () => {
    const order = {
      orderId: "4081453973",
      status: "Fulfilled",
      vendor_submissions: {
        onos: {
          sent: true,
          external_id: "CS-76508-32458",
        },
      },
      items: [
        {
          transactionId: "5090766154",
          cost_breakdown: { vendorProductId: "0123456789abcdef01234567" },
          tracking_info: { status: "New", tracking: "" },
        },
      ],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };

    db.EtsyOrder.findOne.mockImplementation((query) => {
      if (query["vendor_submissions.onos.external_id"] === "CS-76508-32458") {
        return Promise.resolve(order);
      }
      return Promise.resolve(null);
    });
    db.orderCustomProduct.findOne.mockResolvedValue(null);
    mockSelectLean(db.vendorProduct.find, [
      { _id: "0123456789abcdef01234567", vendor_id: "111111111111111111111111" },
    ]);
    mockSelectLean(db.vendor.find, [
      { _id: "111111111111111111111111", name: "OnosPOD", fulfillment_type: "onos" },
    ]);

    const result = await vendorWebhookService.handleWebhook({
      provider: "onos",
      payload: {
        status: true,
        data: {
          id: "CS-76508-32458",
          order_id: "4081453973",
          status: "Shipped",
          tracking_number: "YT1234567891234567",
          carrier: "USPS",
        },
      },
      req: { headers: {}, query: {} },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        provider: "onos",
        result: expect.objectContaining({
          collection: "etsyorders",
          orderId: "4081453973",
          changedItems: 1,
          orderStatusChanged: true,
          tracking: "YT1234567891234567",
          carrier: "USPS",
          shipped: true,
        }),
      })
    );
    expect(order.items[0].tracking_info).toEqual(
      expect.objectContaining({
        fulfillment: "Onos",
        tracking: "YT1234567891234567",
        status: "Shipped",
        note: "carrier:USPS",
      })
    );
    expect(order.status).toBe("Shipped");
    expect(order.shippedAt).toBeInstanceOf(Date);
    expect(order.vendor_submissions.onos).toEqual(
      expect.objectContaining({
        last_webhook: expect.objectContaining({ status: true }),
        webhook_attempt_count: 1,
        webhook_status: "shipped",
        webhook_tracking: "YT1234567891234567",
        webhook_carrier: "USPS",
      })
    );
    expect(order.markModified).toHaveBeenCalledWith("items");
    expect(order.markModified).toHaveBeenCalledWith("vendor_submissions");
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid webhook secret when provider secret is configured", async () => {
    process.env.ONOS_WEBHOOK_SECRET = "expected-secret";

    await expect(
      vendorWebhookService.handleWebhook({
        provider: "onos",
        payload: { data: { id: "CS-1", order_id: "ORDER-1" } },
        req: { headers: { "x-webhook-token": "wrong-secret" }, query: {} },
      })
    ).rejects.toMatchObject({
      status: 401,
      message: "Invalid webhook secret",
    });

    expect(db.EtsyOrder.findOne).not.toHaveBeenCalled();
  });

  test("accepts valid Onos HMAC SHA256 signature", async () => {
    process.env.ONOS_WEBHOOK_SECRET = "expected-secret";
    const rawBody = Buffer.from(JSON.stringify({
      status: true,
      data: {
        id: "CS-76508-32458",
        order_id: "4081453973",
        status: "Shipped",
        tracking_number: "YT1234567891234567",
        carrier: "USPS",
      },
    }));
    const signature = crypto
      .createHmac("sha256", process.env.ONOS_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");
    const payload = JSON.parse(rawBody.toString("utf8"));
    const order = {
      orderId: "4081453973",
      status: "Fulfilled",
      vendor_submissions: {
        onos: {
          sent: true,
          external_id: "CS-76508-32458",
        },
      },
      items: [
        {
          cost_breakdown: { vendorProductId: "0123456789abcdef01234567" },
          tracking_info: { status: "New", tracking: "" },
        },
      ],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };

    db.EtsyOrder.findOne.mockImplementation((query) => {
      if (query["vendor_submissions.onos.external_id"] === "CS-76508-32458") {
        return Promise.resolve(order);
      }
      return Promise.resolve(null);
    });
    db.orderCustomProduct.findOne.mockResolvedValue(null);
    mockSelectLean(db.vendorProduct.find, [
      { _id: "0123456789abcdef01234567", vendor_id: "111111111111111111111111" },
    ]);
    mockSelectLean(db.vendor.find, [
      { _id: "111111111111111111111111", name: "OnosPOD", fulfillment_type: "onos" },
    ]);

    const result = await vendorWebhookService.handleWebhook({
      provider: "onos",
      payload,
      req: {
        rawBody,
        headers: { "x-onos-hmac-sha256": signature },
        query: {},
      },
    });

    expect(result.ok).toBe(true);
    expect(order.items[0].tracking_info.tracking).toBe("YT1234567891234567");
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid Onos HMAC SHA256 signature", async () => {
    process.env.ONOS_WEBHOOK_SECRET = "expected-secret";

    await expect(
      vendorWebhookService.handleWebhook({
        provider: "onos",
        payload: { data: { id: "CS-1", order_id: "ORDER-1" } },
        req: {
          rawBody: Buffer.from('{"data":{"id":"CS-1","order_id":"ORDER-1"}}'),
          headers: { "x-onos-hmac-sha256": "wrong-signature" },
          query: {},
        },
      })
    ).rejects.toMatchObject({
      status: 401,
      message: "Invalid webhook secret",
    });

    expect(db.EtsyOrder.findOne).not.toHaveBeenCalled();
  });

  test("skips duplicate Onos webhook when tracking state is unchanged", async () => {
    const order = {
      orderId: "4081453973",
      status: "Shipped",
      shippedAt: new Date("2026-06-09T00:00:00.000Z"),
      vendor_submissions: {
        onos: {
          sent: true,
          external_id: "CS-76508-32458",
          webhook_attempt_count: 1,
          webhook_tracking: "YT1234567891234567",
        },
      },
      items: [
        {
          transactionId: "5090766154",
          cost_breakdown: { vendorProductId: "0123456789abcdef01234567" },
          tracking_info: {
            fulfillment: "Onos",
            tracking: "YT1234567891234567",
            status: "Shipped",
            note: "carrier:USPS",
          },
        },
      ],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };

    db.EtsyOrder.findOne.mockImplementation((query) => {
      if (query["vendor_submissions.onos.external_id"] === "CS-76508-32458") {
        return Promise.resolve(order);
      }
      return Promise.resolve(null);
    });
    db.orderCustomProduct.findOne.mockResolvedValue(null);
    mockSelectLean(db.vendorProduct.find, [
      { _id: "0123456789abcdef01234567", vendor_id: "111111111111111111111111" },
    ]);
    mockSelectLean(db.vendor.find, [
      { _id: "111111111111111111111111", name: "OnosPOD", fulfillment_type: "onos" },
    ]);

    const result = await vendorWebhookService.handleWebhook({
      provider: "onos",
      payload: {
        status: true,
        data: {
          id: "CS-76508-32458",
          order_id: "4081453973",
          status: "Shipped",
          tracking_number: "YT1234567891234567",
          carrier: "USPS",
        },
      },
      req: { headers: {}, query: {} },
    });

    expect(result.result).toEqual(
      expect.objectContaining({
        matchedItems: 1,
        changedItems: 0,
        orderStatusChanged: false,
        skipped: true,
      })
    );
    expect(order.vendor_submissions.onos.webhook_attempt_count).toBe(1);
    expect(order.markModified).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
  });
});
