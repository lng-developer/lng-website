jest.mock("../../utils/cloudinary", () => ({
  uploader: { upload_stream: jest.fn() },
}));

jest.mock("../../service/cloudflareR2/r2.service", () => ({
  uploadBufferToR2: jest.fn(),
}));

jest.mock("../../service/fulfillment", () => ({
  PROVIDERS: [],
  send: jest.fn(),
}));

jest.mock("../../service/pointsService", () => ({
  addPointsFromTask: jest.fn(),
  addPenaltyForScaleReject: jest.fn(),
}));

jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../service/orderLifecycleLogger", () => ({
  logOrderLifecycleEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../models", () => ({
  orderCustomProduct: { findOne: jest.fn(), aggregate: jest.fn() },
  vendorProduct: { find: jest.fn() },
  listing: { findOne: jest.fn(), find: jest.fn() },
  user: {},
  Team: {},
  shop: {},
  role: {},
}));

const db = require("../../models");
const FulfillmentService = require("../../service/fulfillment");
const { logOrderLifecycleEvent } = require("../../service/orderLifecycleLogger");
const controller = require("../scale.controller");

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("scale lifecycle hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("confirmScaleForItem logs SCALE_ITEM_REJECTED", async () => {
    const item = {
      orderItemId: "ITEM-1",
      scale_status: "Pending",
      fulfillment_file: { front: "https://cdn/front.png" },
      markModified: jest.fn(),
    };
    const order = {
      _id: "order-1",
      orderId: "ORDER-1",
      platform: "Amazon",
      scale_overall_status: "Pending",
      items: [item],
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockResolvedValue(order);

    const req = {
      params: { orderId: "ORDER-1", orderItemId: "ITEM-1" },
      body: { decision: "reject", note: "bad file" },
      user: { _id: "user-1", email: "qc@example.com", role: "Admin" },
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.confirmScaleForItem(req, res);

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: "ORDER-1",
      stage: "SCALE",
      eventType: "SCALE_ITEM_REJECTED",
      status: "success",
      metadata: expect.objectContaining({
        orderItemId: "ITEM-1",
        fromScaleStatus: "Pending",
        toScaleStatus: "QC Rejected",
        fromOverallStatus: "Pending",
        toOverallStatus: "QC Rejected",
      }),
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: "ORDER-1",
      stage: "QC",
      eventType: "QC_REJECTED",
      status: "success",
      metadata: { orderItemId: "ITEM-1", note: "bad file" },
    }));
  });

  test("confirmScaleForItem logs SCALE_ITEM_APPROVED", async () => {
    const approved = {
      orderItemId: "ITEM-1",
      scale_status: "Pending",
      fulfillment_file: { front: "https://cdn/front.png" },
      markModified: jest.fn(),
    };
    const pending = {
      orderItemId: "ITEM-2",
      scale_status: "Pending",
      fulfillment_file: { front: "https://cdn/front2.png" },
      markModified: jest.fn(),
    };
    const order = {
      _id: "order-1",
      orderId: "ORDER-1",
      platform: "Amazon",
      scale_overall_status: "Pending",
      items: [approved, pending],
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockResolvedValue(order);

    const req = {
      params: { orderId: "ORDER-1", orderItemId: "ITEM-1" },
      body: { decision: "approve" },
      user: { _id: "user-1", email: "qc@example.com", role: "Admin" },
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.confirmScaleForItem(req, res);

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      stage: "SCALE",
      eventType: "SCALE_ITEM_APPROVED",
      status: "success",
      metadata: expect.objectContaining({
        orderItemId: "ITEM-1",
        fromScaleStatus: "Pending",
        toScaleStatus: "Complete",
      }),
    }));
    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      stage: "QC",
      eventType: "QC_APPROVED",
      status: "success",
      metadata: { orderItemId: "ITEM-1", note: "" },
    }));
  });

  test("confirmScaleForItem auto pushes vendor when final approval has one provider", async () => {
    const item = {
      orderItemId: "ITEM-1",
      scale_status: "Pending",
      fulfillment_file: { front: "https://cdn/front.png" },
      cost_breakdown: { vendorProductId: "507f1f77bcf86cd799439011" },
      markModified: jest.fn(),
    };
    const order = {
      _id: "order-1",
      orderId: "ORDER-1",
      platform: "Amazon",
      scale_overall_status: "Pending",
      status: "New",
      vendor_submissions: {},
      items: [item],
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    db.orderCustomProduct.findOne.mockResolvedValue(order);
    db.vendorProduct.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { vendor_id: { name: "Merchize", fulfillment_type: "API", status: "Active" } },
      ]),
    });
    FulfillmentService.PROVIDERS = [{ key: "merchize" }];
    FulfillmentService.send.mockImplementation(async (sentOrder) => {
      sentOrder.scale_overall_status = "Sent";
      sentOrder.status = "Fulfilled";
      return {
        alreadySent: false,
        vendorKey: "merchize",
        response: { ok: true },
      };
    });

    const req = {
      params: { orderId: "ORDER-1", orderItemId: "ITEM-1" },
      body: { decision: "approve", provider: "merchize" },
      user: { _id: "user-1", email: "qc@example.com", role: "Admin" },
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.confirmScaleForItem(req, res);

    expect(FulfillmentService.send).toHaveBeenCalledWith(order, "merchize");
    expect(order.scale_overall_status).toBe("Sent");
    expect(order.status).toBe("Fulfilled");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: "Approved and order sent to merchize.",
      item_scale_status: "Complete",
      order_scale_overall_status: "Sent",
    }));
  });

  test("retrySendGrabink logs VENDOR_PUSH_SUCCESS", async () => {
    const order = {
      _id: "order-1",
      orderId: "ORDER-1",
      platform: "Amazon",
      scale_overall_status: "Ready",
      vendor_submissions: {},
      items: [],
    };
    db.orderCustomProduct.findOne.mockResolvedValue(order);
    FulfillmentService.send.mockResolvedValue({
      alreadySent: false,
      vendorKey: "merchize",
      response: { ok: true },
    });

    const req = {
      params: { orderId: "ORDER-1" },
      query: { provider: "merchize" },
      body: {},
      user: { _id: "user-1", email: "cs@example.com", role: "Admin" },
      headers: { "user-agent": "jest" },
    };
    const res = makeRes();

    await controller.retrySendGrabink(req, res);

    expect(logOrderLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      platform: "amazon",
      orderId: "ORDER-1",
      stage: "VENDOR_PUSH",
      eventType: "VENDOR_PUSH_SUCCESS",
      status: "success",
      metadata: expect.objectContaining({
        provider: "merchize",
        alreadySent: false,
      }),
    }));
  });
});
