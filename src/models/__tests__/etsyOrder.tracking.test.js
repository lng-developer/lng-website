const EtsyOrder = require("../etsyOrder.model");

test("stores the carrier-confirmed handoff timestamp on Etsy order items", () => {
  const path = EtsyOrder.schema.path("items.tracking_info.actualShipAt");

  expect(path).toBeDefined();
  expect(path.instance).toBe("Date");
});
