const { calculateEtsyEstimatedFee } = require("../etsyFee");

test("calculates the Vietnam Etsy fee for order 4067362471", () => {
  expect(calculateEtsyEstimatedFee({ orderTotal: 53.38, salesTax: 3.02 })).toBe(6.74);
});

test("does not produce negative or non-finite fees", () => {
  expect(calculateEtsyEstimatedFee({ orderTotal: -1, salesTax: 3 })).toBe(0);
  expect(calculateEtsyEstimatedFee({ orderTotal: "bad", salesTax: null })).toBe(0);
});
