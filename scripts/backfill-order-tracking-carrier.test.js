const { carrierFromNote } = require("./backfill-order-tracking-carrier");

test("uses the last legacy carrier marker", () => {
  expect(carrierFromNote("source: vendor | carrier: USPS | carrier: Yanwen")).toBe("Yanwen");
  expect(carrierFromNote("source: vendor")).toBe("");
});
