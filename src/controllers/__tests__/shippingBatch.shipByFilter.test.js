const { _test } = require("../shippingBatch.contrller");

test("filters tracking orders due today by the Amazon ship-by date", () => {
  const query = _test.buildCheckOrdersQuery("shop-1", {
    shipBy: "today",
    shipByFrom: "2026-09-24",
    shipByTo: "2026-09-24",
  });

  expect(query.shipByDate).toEqual({
    $gte: new Date("2026-09-24T00:00:00.000Z"),
    $lt: new Date("2026-09-25T00:00:00.000Z"),
  });
});

test("filters overdue tracking orders before the selected ship-by day", () => {
  const query = _test.buildCheckOrdersQuery("shop-1", {
    shipBy: "overdue",
    shipByFrom: "2026-09-24",
  });

  expect(query.shipByDate).toEqual({ $lt: new Date("2026-09-24T00:00:00.000Z") });
});
