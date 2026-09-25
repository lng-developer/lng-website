jest.mock("../providers/lng", () => ({
  key: "lng",
  canHandle: () => false,
  send: jest.fn(),
}));

const lngProvider = require("../providers/lng");
const fulfillment = require("../index");

describe("fulfillment service", () => {
  beforeEach(() => jest.clearAllMocks());

  test("records provider failure before rethrowing", async () => {
    const error = new Error("unable to verify the first certificate");
    error.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    lngProvider.send.mockRejectedValueOnce(error);

    const order = {
      vendor_submissions: {},
      markModified: jest.fn(),
      save: jest.fn(),
    };

    await expect(fulfillment.send(order, "lng")).rejects.toThrow("unable to verify the first certificate");

    expect(order.vendor_submissions.lng).toMatchObject({
      sent: false,
      attempt_count: 1,
      last_error: {
        message: "unable to verify the first certificate",
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      },
    });
    expect(order.markModified).toHaveBeenCalledWith("vendor_submissions");
    expect(order.save).toHaveBeenCalledTimes(1);
  });

  test("forwards Etsy channel to the LNG provider", async () => {
    lngProvider.send.mockResolvedValueOnce({ data: { success: true } });
    const order = { vendor_submissions: {}, markModified: jest.fn(), save: jest.fn() };

    await fulfillment.send(order, "lng", { sourceChannel: "ETSY" });

    expect(lngProvider.send).toHaveBeenCalledWith(order, { sourceChannel: "ETSY" });
  });
});
