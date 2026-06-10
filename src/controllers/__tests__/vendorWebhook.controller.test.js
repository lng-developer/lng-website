jest.mock("../../service/vendorWebhook.service", () => ({
  handleWebhook: jest.fn(),
}));

const vendorWebhookService = require("../../service/vendorWebhook.service");
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
  });
});
