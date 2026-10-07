jest.mock("../../models", () => ({
  EtsyOrder: { findOne: jest.fn() },
  orderCustomProduct: { findOne: jest.fn() },
  vendorProduct: { find: jest.fn() },
  vendor: { find: jest.fn() },
  FulfillmentLifecycleEvent: { create: jest.fn() },
}));

const crypto = require("crypto");
const db = require("../../models");
const service = require("../vendorWebhook.service");

const secret = "test-fulfillment-secret";

function event(overrides = {}) {
  return {
    eventId: "b8f5ae24-df7c-4b54-b0c9-7e6c69fd1122",
    eventType: "shipment.label_ready",
    occurredAt: "2026-10-07T08:00:00.000Z",
    tenantReference: "tenant-1",
    externalOrderId: "ORDER-1",
    fulfillmentOrderId: "fulfillment-order-1",
    shipment: { trackingNumber: "TRACK-1", labelUrl: "https://labels.example/1" },
    ...overrides,
  };
}

function request(payload, overrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return {
    rawBody,
    headers: {
      "x-lng-event-id": payload.eventId,
      "x-lng-event-timestamp": timestamp,
      "x-lng-signature": `sha256=${signature}`,
      ...(overrides.headers || {}),
    },
  };
}

describe("handleFulfillmentLifecycleWebhook", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...oldEnv, FULFILLMENT_LIFECYCLE_WEBHOOK_SECRET: secret };
    db.EtsyOrder.findOne.mockResolvedValue({ _id: "order-object-id" });
    db.orderCustomProduct.findOne.mockResolvedValue(null);
    db.FulfillmentLifecycleEvent.create.mockResolvedValue({});
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test("accepts a signed known lifecycle event and records only safe metadata", async () => {
    const payload = event();
    const result = await service.handleFulfillmentLifecycleWebhook({ payload, req: request(payload) });

    expect(result).toEqual({ ok: true, duplicate: false });
    expect(db.FulfillmentLifecycleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: payload.eventId,
        eventType: payload.eventType,
        externalOrderId: payload.externalOrderId,
        fulfillmentOrderId: payload.fulfillmentOrderId,
      })
    );
    expect(db.FulfillmentLifecycleEvent.create.mock.calls[0][0]).not.toHaveProperty("rawPayload");
  });

  test.each([
    ["wrong signature", (payload) => request(payload, { headers: { "x-lng-signature": "sha256=wrong" } })],
    ["expired timestamp", (payload) => request(payload, { headers: { "x-lng-event-timestamp": "1" } })],
  ])("rejects %s before persistence", async (_name, makeRequest) => {
    const payload = event();
    await expect(service.handleFulfillmentLifecycleWebhook({ payload, req: makeRequest(payload) })).rejects.toMatchObject({ status: 401 });
    expect(db.FulfillmentLifecycleEvent.create).not.toHaveBeenCalled();
  });

  test("returns success for a duplicate event id", async () => {
    const payload = event();
    const duplicate = Object.assign(new Error("duplicate"), { code: 11000 });
    db.FulfillmentLifecycleEvent.create.mockRejectedValue(duplicate);

    await expect(service.handleFulfillmentLifecycleWebhook({ payload, req: request(payload) }))
      .resolves.toEqual({ ok: true, duplicate: true });
  });

  test("rejects an unknown LNG order", async () => {
    const payload = event();
    db.EtsyOrder.findOne.mockResolvedValue(null);

    await expect(service.handleFulfillmentLifecycleWebhook({ payload, req: request(payload) }))
      .rejects.toMatchObject({ status: 404, message: "Fulfillment lifecycle order not found" });
  });

  test("rejects an unsupported event type before persistence", async () => {
    const payload = event({ eventType: "shipment.untrusted" });
    await expect(service.handleFulfillmentLifecycleWebhook({ payload, req: request(payload) }))
      .rejects.toMatchObject({ status: 400 });
    expect(db.FulfillmentLifecycleEvent.create).not.toHaveBeenCalled();
  });
});
