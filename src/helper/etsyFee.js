const DEFAULT_VND_PER_USD = 26000;

const positiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

const calculateEtsyEstimatedFee = ({
  orderTotal,
  salesTax,
  exchangeRate = DEFAULT_VND_PER_USD,
} = {}) => {
  const total = positiveNumber(orderTotal);
  if (!total) return 0;

  const taxExclusiveTotal = Math.max(0, total - positiveNumber(salesTax));
  const rate = positiveNumber(exchangeRate) || DEFAULT_VND_PER_USD;
  const fee =
    0.065 * taxExclusiveTotal +
    0.045 * total +
    11500 / rate +
    0.0124 * taxExclusiveTotal;

  return Number(fee.toFixed(2));
};

module.exports = { DEFAULT_VND_PER_USD, calculateEtsyEstimatedFee };
