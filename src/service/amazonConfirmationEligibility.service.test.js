const { evaluateAmazonConfirmationEligibility } = require("./amazonConfirmationEligibility.service");

const NOW = new Date("2026-09-25T12:00:00.000Z");

function order(overrides = {}) {
  return {
    status: "Shipped",
    shipByDate: new Date("2026-09-26T07:00:00.000Z"),
    items: [{
      orderItemId: "item-1",
      quantity: 1,
      tracking_info: {
        tracking: "9234690339407902297338",
        carrier: "USPS",
        actualShipAt: new Date("2026-09-25T05:00:00.000Z"),
      },
    }],
    ...overrides,
  };
}

describe("evaluateAmazonConfirmationEligibility", () => {
  test("returns a Pacific ship date for one fully shipped order", () => {
    const result = evaluateAmazonConfirmationEligibility({
      order: order({
        shipByDate: new Date("2026-09-25T07:00:00.000Z"),
        items: [{
          tracking_info: {
            tracking: "9234690339407902297338",
            carrier: "USPS",
            actualShipAt: new Date("2026-09-25T06:59:59.000Z"),
          },
        }],
      }),
      now: NOW,
    });

    expect(result).toEqual({
      readyForReview: true,
      reasons: [],
      shipDate: "2026-09-24",
      actualShipAt: new Date("2026-09-25T06:59:59.000Z"),
      tracking: "9234690339407902297338",
      carrier: "USPS",
    });
  });

  test.each([
    ["missing tracking", order({ items: [{ tracking_info: { carrier: "USPS", actualShipAt: NOW } }] }), "MISSING_TRACKING"],
    ["placeholder tracking", order({ items: [{ tracking_info: { tracking: "---", carrier: "USPS", actualShipAt: NOW } }] }), "INVALID_TRACKING"],
    ["missing carrier", order({ items: [{ tracking_info: { tracking: "9234690339407902297338", actualShipAt: NOW } }] }), "MISSING_CARRIER"],
    ["missing actual ship date", order({ items: [{ tracking_info: { tracking: "9234690339407902297338", carrier: "USPS" } }] }), "MISSING_ACTUAL_SHIP_DATE"],
    ["future actual ship date", order({ items: [{ tracking_info: { tracking: "9234690339407902297338", carrier: "USPS", actualShipAt: new Date("2026-09-25T12:00:01.000Z") } }] }), "FUTURE_ACTUAL_SHIP_DATE"],
    ["cancelled order", order({ status: "Cancelled" }), "ORDER_NOT_ELIGIBLE"],
    ["buyer cancellation", order({ buyerRequestedCancellation: true }), "BUYER_CANCELLATION"],
    ["missing ship by", order({ shipByDate: null }), "MISSING_SHIP_BY"],
    ["prior Amazon reservation", order({ amazonConfirmation: { state: "submitted" } }), "AMAZON_CONFIRMATION_EXISTS"],
  ])("blocks %s", (_name, input, reason) => {
    const result = evaluateAmazonConfirmationEligibility({ order: input, now: NOW });

    expect(result.readyForReview).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  test("blocks a split shipment when items do not share tracking", () => {
    const result = evaluateAmazonConfirmationEligibility({
      order: order({
        items: [
          { tracking_info: { tracking: "9234690339407902297338", carrier: "USPS", actualShipAt: NOW } },
          { tracking_info: { tracking: "9400111899560000000000", carrier: "USPS", actualShipAt: NOW } },
        ],
      }),
      now: NOW,
    });

    expect(result).toEqual(expect.objectContaining({
      readyForReview: false,
      reasons: expect.arrayContaining(["SPLIT_OR_UNTRACKED_ITEM"]),
    }));
  });

  test("blocks an order whose Pacific ship date is after Ship By", () => {
    const result = evaluateAmazonConfirmationEligibility({
      order: order({
        shipByDate: new Date("2026-09-25T06:59:59.000Z"),
        items: [{
          tracking_info: {
            tracking: "9234690339407902297338",
            carrier: "USPS",
            actualShipAt: new Date("2026-09-25T07:00:00.000Z"),
          },
        }],
      }),
      now: NOW,
    });

    expect(result).toEqual(expect.objectContaining({
      readyForReview: false,
      shipDate: "2026-09-25",
      reasons: expect.arrayContaining(["SHIP_DATE_AFTER_SHIP_BY"]),
    }));
  });
});
