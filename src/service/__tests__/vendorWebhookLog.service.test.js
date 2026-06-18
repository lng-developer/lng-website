jest.mock("../../models", () => ({
  VendorWebhookLog: {
    create: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
  },
}));

const db = require("../../models");
const vendorWebhookLogService = require("../vendorWebhookLog.service");

function mockFindChain(rows) {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  };
  db.VendorWebhookLog.find.mockReturnValue(chain);
  return chain;
}

describe("vendorWebhookLog.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("builds a success log document without storing secret header values", () => {
    const doc = vendorWebhookLogService.buildLogDocument({
      provider: "Onos",
      req: {
        method: "POST",
        originalUrl: "/api/vendor-webhooks/onos",
        ip: "127.0.0.1",
        headers: {
          "user-agent": "jest",
          "x-onos-hmac-sha256": "actual-signature-value",
          "x-webhook-token": "secret-value",
        },
      },
      payload: { data: { order_id: "ORDER-1" } },
      result: {
        event: {
          orderId: "ORDER-1",
          externalId: "ONOS-1",
          status: "fulfilled",
          tracking: "TRACK-1",
          carrier: "USPS",
        },
        result: {
          collection: "etsyorders",
          matchedItems: 1,
          changedItems: 1,
          orderStatusChanged: true,
        },
      },
      httpStatus: 200,
    });

    expect(doc).toEqual(
      expect.objectContaining({
        provider: "onos",
        outcome: "success",
        httpStatus: 200,
        orderId: "ORDER-1",
        externalId: "ONOS-1",
        tracking: "TRACK-1",
        carrier: "USPS",
        matchedCollection: "etsyorders",
        matchedItems: 1,
        changedItems: 1,
        orderStatusChanged: true,
      })
    );
    expect(doc.request).toEqual(
      expect.objectContaining({
        signatureType: "onos-hmac",
        userAgent: "jest",
      })
    );
    expect(JSON.stringify(doc)).not.toContain("secret-value");
    expect(JSON.stringify(doc)).not.toContain("actual-signature-value");
  });

  test("creates vendor webhook log", async () => {
    db.VendorWebhookLog.create.mockResolvedValue({ _id: "log-1" });

    await expect(
      vendorWebhookLogService.createVendorWebhookLog({
        provider: "onos",
        req: { headers: {}, query: {} },
        payload: { ok: true },
        result: { ok: true },
        httpStatus: 200,
      })
    ).resolves.toEqual({ _id: "log-1" });

    expect(db.VendorWebhookLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "onos",
        outcome: "success",
      })
    );
  });

  test("lists webhook logs with filters and pagination", async () => {
    const chain = mockFindChain([{ provider: "onos" }]);
    db.VendorWebhookLog.countDocuments.mockResolvedValue(1);

    const result = await vendorWebhookLogService.listVendorWebhookLogs({
      provider: "ONOS",
      outcome: "success",
      page: "2",
      perPage: "10",
    });

    expect(db.VendorWebhookLog.find).toHaveBeenCalledWith({
      provider: "onos",
      outcome: "success",
    });
    expect(chain.skip).toHaveBeenCalledWith(10);
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(result).toEqual({
      data: [{ provider: "onos" }],
      total: 1,
      currentPage: 2,
      totalPages: 1,
    });
  });
});
