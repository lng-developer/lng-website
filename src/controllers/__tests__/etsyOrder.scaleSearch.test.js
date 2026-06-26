jest.mock("../../models", () => ({
  EtsyOrder: {},
  user: {},
  role: {},
  shop: {},
}));

jest.mock("../../models/etsyListing.model", () => ({}));
jest.mock("../../service/cloudflareR2/r2.service", () => ({
  uploadBufferToR2: jest.fn(),
  uploadFilePathToR2: jest.fn(),
}));
jest.mock("../../service/fulfillment", () => ({
  PROVIDERS: [],
  send: jest.fn(),
}));
jest.mock("../../service/orderHistoryLogger", () => ({
  logOrderHistory: jest.fn(),
}));
jest.mock("../../service/etsyTrackingResponse.service", () => ({
  buildEtsyTrackingInfoResponse: jest.fn(() => ({})),
  buildEtsyTrackingSummary: jest.fn(() => ({})),
}));
jest.mock("axios", () => ({}));

const controller = require("../etsyOrder.controller");

describe("buildEtsyScalePipeline search", () => {
  test("matches operational fields used on Scale and QC screens", () => {
    const pipeline = controller._buildEtsyScalePipeline(
      { query: { search: "alice" }, user: { role: "Admin" } },
      ["Need Scale", "Pending"]
    );

    const searchMatch = pipeline.find((stage) => stage.$match?.$or?.some((condition) => condition["items.tracking_info.tracking"]));
    const fields = searchMatch.$match.$or.flatMap((condition) => Object.keys(condition));

    expect(fields).toEqual(expect.arrayContaining([
      "shop.name",
      "items.listingId",
      "items.tracking_info.tracking",
      "items.customizations.textFields.value",
      "items.qc_note",
      "scaledBy.full_name",
      "cs_assignee.full_name",
      "itemVendorProducts.product_name",
      "itemVendors.name",
    ]));
  });
});
