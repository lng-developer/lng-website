jest.mock("../../models", () => ({
  orderCustomProduct: { aggregate: jest.fn() },
  vendorProduct: {},
  vendor: {},
  listing: {},
  Team: {},
  user: {},
}));

const db = require("../../models");
const { buildFilters, buildPipeline, executePipeline, enrichOrdersData } = require("../orderHelper");

describe("orderHelper executePipeline", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.orderCustomProduct.aggregate
      .mockResolvedValueOnce([{ total: 0 }])
      .mockResolvedValueOnce([]);
  });

  test("sorts by order status when requested", async () => {
    const pipeline = [{ $match: { status: { $ne: "Cancelled" } } }];

    await executePipeline(pipeline, 1, 10, {
      sortBy: "status",
      sortOrder: "asc",
    });

    expect(db.orderCustomProduct.aggregate).toHaveBeenNthCalledWith(2, [
      { $match: { status: { $ne: "Cancelled" } } },
      { $sort: { status: 1, purchase_date: -1 } },
      { $skip: 0 },
      { $limit: 10 },
    ]);
  });
});

describe("orderHelper buildPipeline", () => {
  test("places simple order filters before lookup stages and joined filters after shop lookup", async () => {
    const pipeline = await buildPipeline({
      initialMatch: { sellerId: "seller-1" },
      filters: [
        { status: { $in: ["New"] } },
        { purchase_date: { $gte: new Date("2026-06-20T00:00:00.000Z") } },
      ],
      userId: "user-1",
      shopName: "Demo Shop",
      roles: { isAdmin: true },
    });

    expect(pipeline[0]).toEqual({ $match: { sellerId: "seller-1" } });
    expect(pipeline[1]).toEqual({
      $match: {
        $and: [
          { status: { $in: ["New"] } },
          { purchase_date: { $gte: new Date("2026-06-20T00:00:00.000Z") } },
        ],
      },
    });

    const firstLookupIndex = pipeline.findIndex((stage) => stage.$lookup);
    const shopNameMatchIndex = pipeline.findIndex((stage) => stage.$match?.["shop.name"]);

    expect(firstLookupIndex).toBeGreaterThan(1);
    expect(shopNameMatchIndex).toBeGreaterThan(firstLookupIndex);
  });
});

describe("orderHelper buildFilters", () => {
  test("accepts status as an alias for statuses", () => {
    expect(buildFilters({ status: "New", isNoCostCenter: "true" })).toEqual([
      { status: { $in: ["New"] } },
      { base_cost: { $in: [null, 0] } },
    ]);
  });
});

describe("orderHelper enrichOrdersData", () => {
  test("keeps full version3 customization area fields for FE orders", async () => {
    const [order] = await enrichOrdersData([
      {
        orderId: "114-5797564-5559402",
        items: [
          {
            orderItemId: "164336876284961",
            version3Data: {
              customizationInfo: {
                surfaces: [
                  {
                    areas: [
                      {
                        label: "Custom Name",
                        text: "Mrs. Adams",
                        fontFamily: "Lora",
                        Dimensions: { width: 100, height: 20 },
                        Position: { x: 12, y: 34 },
                      },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(order.items[0].version3Data).toEqual([
      expect.objectContaining({
        label: "Custom Name",
        value: "Mrs. Adams",
        text: "Mrs. Adams",
        fontFamily: "Lora",
        Dimensions: { width: 100, height: 20 },
        Position: { x: 12, y: 34 },
      }),
    ]);
  });
});
