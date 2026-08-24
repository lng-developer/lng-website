const { dedupeEtsyAdsDailySummaries } = require("../etsyAds");

test("keeps the latest import for duplicate Etsy shop snapshots on the same day", () => {
  const docs = [
    {
      day: new Date("2026-08-17T00:00:00.000Z"),
      etsyShopId: "66742086",
      totalSpend: 142.32,
      lastImportedAt: new Date("2026-08-18T01:10:55.294Z"),
    },
    {
      day: new Date("2026-08-17T00:00:00.000Z"),
      etsyShopId: "66742086",
      totalSpend: 180.97,
      lastImportedAt: new Date("2026-08-18T06:45:51.854Z"),
    },
  ];

  expect(dedupeEtsyAdsDailySummaries(docs)).toEqual([docs[1]]);
});
