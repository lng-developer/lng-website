const AMAZON_FEE_RATE = 0.15;

const round2 = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
};

const abs2 = (value) => round2(Math.abs(Number(value || 0)));

function calcAmazonRevenue(finance = {}) {
  return round2((finance.item_price || 0) + (finance.shipping_price || 0));
}

function calcAmazonFee(finance = {}) {
  const revenue = calcAmazonRevenue(finance);
  return round2(revenue * AMAZON_FEE_RATE);
}

function calcAmazonReportProfit({
  revenue = 0,
  baseCost = 0,
  fee = 0,
  discount = 0,
  ads = 0,
  opCost = 0,
  refund = 0,
} = {}) {
  const profit1 = round2(revenue - baseCost - fee - abs2(discount) - ads);
  const profit2 = round2(profit1 - opCost - refund);

  return { profit1, profit2 };
}

function calcAmazonOrderProfit({ finance = {}, baseCost = 0 } = {}) {
  const revenue = calcAmazonRevenue(finance);
  const discount = abs2(finance.item_promotion_discount);
  const refund = round2(finance.refund);
  const fee = calcAmazonFee(finance);
  const base = round2(baseCost);
  const opCost = round2(finance.opCost);
  const profit1 = round2(revenue - discount - refund - fee - base);
  const profit2 = round2(profit1 - opCost);

  return { revenue, discount, refund, fee, baseCost: base, opCost, profit1, profit2 };
}

module.exports = {
  round2,
  AMAZON_FEE_RATE,
  calcAmazonRevenue,
  calcAmazonFee,
  calcAmazonReportProfit,
  calcAmazonOrderProfit,
};
