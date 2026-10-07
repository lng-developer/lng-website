jest.mock("../../models", () => ({
  EtsyOrder: { findOne: jest.fn() },
  orderCustomProduct: { findOne: jest.fn() },
  vendorProduct: { find: jest.fn() },
  vendor: { find: jest.fn() },
  FulfillmentLifecycleEvent: { create: jest.fn(), findOne: jest.fn() },
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
    db.FulfillmentLifecycleEvent.findOne.mockResolvedValue(null);
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
    db.FulfillmentLifecycleEvent.findOne.mockResolvedValue({ eventId: payload.eventId });

    await expect(service.handleFulfillmentLifecycleWebhook({ payload, req: request(payload) }))
      .resolves.toEqual({ ok: true, duplicate: true });
    expect(db.EtsyOrder.findOne).not.toHaveBeenCalled();
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

  test("keeps label pending until the carrier handoff event", async () => {
    const order = {
      vendor_submissions: {},
      items: [{ tracking_info: { status: "New", tracking: "" } }],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.EtsyOrder.findOne.mockResolvedValue(order);
    const labelReady = event();

    await service.handleFulfillmentLifecycleWebhook({ payload: labelReady, req: request(labelReady) });
    expect(order.items[0].tracking_info.status).toBe("New");
    expect(order.vendor_submissions.fulfillment_platform_v2).toEqual(expect.objectContaining({
      event_type: "shipment.label_ready",
      label_url: "https://labels.example/1",
    }));

    const handoff = event({
      eventId: "dfbc9504-8511-44f0-a7ca-80e391b373cd",
      eventType: "shipment.carrier_handoff_confirmed",
      occurredAt: "2026-10-07T09:00:00.000Z",
      shipment: { shipmentId: "shipment-1", carrierCode: "VIETTEL_POST", trackingNumber: "TRACK-1", actualShipAt: "2026-10-07T08:55:00.000Z" },
    });
    await service.handleFulfillmentLifecycleWebhook({ payload: handoff, req: request(handoff) });

    expect(order.items[0].tracking_info).toEqual(expect.objectContaining({
      status: "Shipped",
      actualShipAt: new Date("2026-10-07T08:55:00.000Z"),
    }));
    expect(order.save).toHaveBeenCalledTimes(2);
  });
});
