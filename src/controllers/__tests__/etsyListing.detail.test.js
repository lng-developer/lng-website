const EtsyListing = require("../../models/etsyListing.model");
const { getEtsyListingDetail } = require("../etsyListing.controller");

jest.mock("../../models/etsyListing.model", () => ({
  findById: jest.fn(),
}));

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe("getEtsyListingDetail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns the requested EtsyListing fields with price and quantity from raw listing data", async () => {
    const listing = {
      _id: "6a544761cd46fc9c6b50f24e",
      shopId: "6a13c9624e4c21f976ef2f15",
      etsyShopId: "66407438",
      shopName: "Nhimiuoi",
      listingId: "4527664313",
      title: "Custom Pet Portrait Napkins, Personalized Dog Cat Cocktail Napkins, Wedding Bar Favors",
      SKU: "J2536-NK-250626-103",
      syncedAt: new Date("2026-07-16T06:26:05.892Z"),
      updatedAt: new Date("2026-07-16T06:26:05.892Z"),
      raw: {
        price: 30.95,
        quantity: 100,
      },
    };

    EtsyListing.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue(listing),
    });

    const req = { params: { id: "6a544761cd46fc9c6b50f24e" } };
    const res = createResponse();

    await getEtsyListingDetail(req, res);

    expect(EtsyListing.findById).toHaveBeenCalledWith("6a544761cd46fc9c6b50f24e");
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        _id: "6a544761cd46fc9c6b50f24e",
        shopId: "6a13c9624e4c21f976ef2f15",
        etsyShopId: "66407438",
        shopName: "Nhimiuoi",
        listingId: "4527664313",
        title: "Custom Pet Portrait Napkins, Personalized Dog Cat Cocktail Napkins, Wedding Bar Favors",
        SKU: "J2536-NK-250626-103",
        price: 30.95,
        quantity: 100,
        syncedAt: listing.syncedAt,
        updatedAt: listing.updatedAt,
      },
    });
  });
});
