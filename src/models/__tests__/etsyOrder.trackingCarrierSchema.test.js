const EtsyOrder = require("../etsyOrder.model");

test("persists carrier handoff fields for Etsy item tracking", () => {
  expect(EtsyOrder.schema.path("items.tracking_info.carrier")).toBeDefined();
  expect(EtsyOrder.schema.path("items.tracking_info.shipEvidence")).toBeDefined();
});
