const {
  calcAmazonOrderProfit,
  calcAmazonRevenue,
} = require("../amazonFinance");

test("amazon revenue excludes marketplace tax", () => {
  expect(
    calcAmazonRevenue({
      item_price: 36.85,
      shipping_price: 0,
      item_tax: 2.07,
      shipping_tax: 0,
    }),
  ).toBe(36.85);
});

test("amazon order profit subtracts discount refund estimated fee base cost and op cost", () => {
  expect(
    calcAmazonOrderProfit({
      finance: {
        item_price: 40,
        shipping_price: 5,
        item_tax: 3,
        shipping_tax: 1,
        item_promotion_discount: -2,
        fee: 7,
        refund: 4,
        opCost: 1.5,
      },
      baseCost: 10,
    }),
  ).toMatchObject({
    revenue: 45,
    fee: 6.75,
    profit1: 22.25,
    profit2: 20.75,
  });
});

test("amazon fee fallback uses fifteen percent of revenue", () => {
  expect(
    calcAmazonOrderProfit({
      finance: { item_price: 100, shipping_price: 20 },
      baseCost: 0,
    }),
  ).toMatchObject({ fee: 18, profit1: 102 });
});
