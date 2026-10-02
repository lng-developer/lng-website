jest.mock("../../models", () => ({
  EtsyAdsDailySummary: { find: jest.fn() },
  EtsyOrder: {},
  user: {},
  SkuMappingConfig: {},
}));
jest.mock("../../models/etsyListing.model", () => ({}));
jest.mock("../../utils/skuMigrate", () => ({ resolveMappedSku: (sku) => sku }));

const db = require("../../models");
const { listEtsyAds } = require("../etsyAds.controller");

test("list response excludes raw Etsy Ads payloads", async () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  };
  db.EtsyAdsDailySummary.find.mockReturnValue(chain);
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

  await listEtsyAds({ query: {} }, res);

  expect(chain.select).toHaveBeenCalledWith(
    "-rows.rawStats -rows.rawListing -sourceMeta -rawOverview"
  );
});

const { getSkuMappingScopeQuery } = jest.requireActual("../../utils/skuMigrate");

test("Etsy Ads scope includes scoped and legacy global configs", () => {
  expect(getSkuMappingScopeQuery("etsy_ads")).toEqual({
    $or: [
      { scopes: { $exists: false } },
      { scopes: { $size: 0 } },
      { scopes: "etsy_ads" },
    ],
  });
});
