const merchize = require("../merchize");

describe("merchize provider", () => {
    test("adds valid printing_method to catalog line items", () => {
        const payload = merchize.buildPayload({
            orderId: "ORDER-1",
            customer_infor: {},
            items: [{
                scale_status: "Complete",
                quantity: 1,
                image: "https://cdn.example/mockup.png",
                fulfillment_file: { front: "https://cdn.example/front.png" },
                cost_breakdown: {
                    matchedSku: "5000US000WHIAA01",
                    printing_method: "dtg",
                },
            }],
        });

        expect(payload.items[0].printing_method).toBe("DTG");
    });

    test("omits invalid printing_method so Merchize uses store default", () => {
        const payload = merchize.buildPayload({
            orderId: "ORDER-1",
            customer_infor: {},
            items: [{
                scale_status: "Complete",
                quantity: 1,
                image: "https://cdn.example/mockup.png",
                fulfillment_file: { front: "https://cdn.example/front.png" },
                cost_breakdown: {
                    matchedSku: "5000US000WHIAA01",
                    printing_method: "SCREEN",
                },
            }],
        });

        expect(payload.items[0]).not.toHaveProperty("printing_method");
    });
});
