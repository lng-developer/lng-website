jest.mock("../providers/lng", () => ({
  key: "lng",
  canHandle: () => false,
  send: jest.fn(),
}));

const lngProvider = require("../providers/lng");
const fulfillment = require("../index");

describe("fulfillment service", () => {
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
});
