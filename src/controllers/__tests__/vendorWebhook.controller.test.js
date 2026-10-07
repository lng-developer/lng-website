jest.mock("../../service/vendorWebhook.service", () => ({
  handleWebhook: jest.fn(),
  handleFulfillmentLifecycleWebhook: jest.fn(),
}));

jest.mock("../../service/vendorWebhookLog.service", () => ({
  safeCreateVendorWebhookLog: jest.fn().mockResolvedValue({}),
  listVendorWebhookLogs: jest.fn(),
}));

const vendorWebhookService = require("../../service/vendorWebhook.service");
const vendorWebhookLogService = require("../../service/vendorWebhookLog.service");
const vendorWebhookController = require("../vendorWebhook.controller");

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe("vendorWebhook.controller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("GET verification endpoint returns 200 without processing webhook payload", () => {
    const req = { params: { provider: "onos" } };
    const res = makeRes();

    vendorWebhookController.verifyVendorWebhookEndpoint(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      provider: "onos",
      message: "Vendor webhook endpoint is available",
    });
    expect(vendorWebhookService.handleWebhook).not.toHaveBeenCalled();
    expect(vendorWebhookLogService.safeCreateVendorWebhookLog).not.toHaveBeenCalled();
  });

  test("POST webhook logs successful processing", async () => {
    const result = {
      ok: true,
      provider: "onos",
      event: { orderId: "ORDER-1", tracking: "TRACK-1" },
      result: { changedItems: 1 },
    };
    vendorWebhookService.handleWebhook.mockResolvedValue(result);

    const req = {
      params: { provider: "onos" },
      body: { data: { order_id: "ORDER-1" } },
      headers: {},
      query: {},
    };
    const res = makeRes();

    await vendorWebhookController.receiveVendorWebhook(req, res);

    expect(res.json).toHaveBeenCalledWith(result);
    expect(vendorWebhookLogService.safeCreateVendorWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "onos",
        payload: req.body,
        result,
        httpStatus: 200,
      })
    );
  });

  test("POST webhook logs failed processing", async () => {
    const err = new Error("Webhook order not found");
    err.status = 404;
    err.event = { provider: "onos", orderId: "ORDER-1" };
    vendorWebhookService.handleWebhook.mockRejectedValue(err);

    const req = {
      params: { provider: "onos" },
      body: { data: { order_id: "ORDER-1" } },
      headers: {},
      query: {},
    };
    const res = makeRes();

    await vendorWebhookController.receiveVendorWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      ok: false,
      message: "Webhook order not found",
      event: err.event,
    });
    expect(vendorWebhookLogService.safeCreateVendorWebhookLog).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "onos",
        payload: req.body,
        error: err,
        httpStatus: 404,
      })
    );
  });

  test("Fulfillment lifecycle callback does not use the raw vendor webhook logger", async () => {
    vendorWebhookService.handleFulfillmentLifecycleWebhook.mockResolvedValue({ ok: true, duplicate: false });
    const req = { body: { customer: { address: "PII" } }, headers: {} };
    const res = makeRes();

    await vendorWebhookController.receiveFulfillmentLifecycleWebhook(req, res);

    expect(res.json).toHaveBeenCalledWith({ ok: true, duplicate: false });
    expect(vendorWebhookLogService.safeCreateVendorWebhookLog).not.toHaveBeenCalled();
  });

  test("lists webhook logs", async () => {
    const result = { data: [], total: 0, currentPage: 1, totalPages: 1 };
    vendorWebhookLogService.listVendorWebhookLogs.mockResolvedValue(result);

    const req = { query: { provider: "onos" } };
    const res = makeRes();

    await vendorWebhookController.listVendorWebhookLogs(req, res);

    expect(vendorWebhookLogService.listVendorWebhookLogs).toHaveBeenCalledWith(req.query);
    expect(res.json).toHaveBeenCalledWith(result);
  });
});
