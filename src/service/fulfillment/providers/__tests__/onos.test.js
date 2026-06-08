jest.mock("axios", () => ({
    post: jest.fn(),
}));

const axios = require("axios");
const onos = require("../onos");

describe("onos fulfillment provider", () => {
    const oldEnv = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = {
            ...oldEnv,
            NODE_ENV: "development",
            ONOS_API_KEY: "test-token",
            ONOS_API_BASE_URL: "https://api-app.onospod.com/api/v1",
            ONOS_SHIPPING_METHOD_DEFAULT: "SBTT",
        };
    });

    afterAll(() => {
        process.env = oldEnv;
    });

    test("builds an Onos create-order payload from a completed order", () => {
        const payload = onos._helpers.buildPayload({
            orderId: "ORDER-1",
            shipping_type: "Standard",
            customer_infor: {
                name: "Carolyn Meador",
                address: "9701 W Beacon Light Rd",
                address_2: "",
                city: "Star",
                state: "ID",
                zip_code: "83669-5109",
                country: "US",
                phone_number: "+1 929-436-4790 ext. 37223",
            },
            items: [
                {
                    scale_status: "Complete",
                    quantity: 1,
                    sku: "HW-SHIRT-AS-DESIGN-L",
                    title: "US Hawaii Shirt",
                    baseImage: { imageUrl: "https://cdn.example/mockup.jpg" },
                    fulfillment_file: {
                        front: "https://cdn.example/front.png",
                        left_chest: "https://cdn.example/chest.png",
                    },
                    cost_breakdown: {
                        matchedSku: "HW-SHIRT-AS-DESIGN-L",
                        itemDisplayName: "US Hawaii Shirt",
                        sizeValue: "L",
                        colorValue: "As Design",
                        base_cost_each: 6.31,
                    },
                },
            ],
        });

        expect(payload).toEqual(
            expect.objectContaining({
                order_id: "ORDER-1",
                identifier: "API",
                shipping_method: "SBTT",
                shipping_info: expect.objectContaining({
                    full_name: "Carolyn Meador",
                    address_1: "9701 W Beacon Light Rd",
                    postcode: "83669-5109",
                    state: "ID",
                }),
                items: [
                    expect.objectContaining({
                        name: "US Hawaii Shirt",
                        product_id: "HW-SHIRT-AS-DESIGN-L",
                        sku: "HW-SHIRT-AS-DESIGN-L",
                        quantity: 1,
                        print_areas: [
                            { key: "front", value: "https://cdn.example/front.png" },
                            { key: "chest_left", value: "https://cdn.example/chest.png" },
                        ],
                    }),
                ],
            })
        );
    });

    test("sends create order with bearer token and returns external id", async () => {
        const order = {
            toObject: () => ({
                orderId: "ORDER-2",
                customer_infor: {
                    name: "Jane Buyer",
                    address: "123 Main St",
                    city: "Boise",
                    state: "ID",
                    zip_code: "83701",
                    country: "US",
                },
                items: [
                    {
                        scale_status: "Complete",
                        quantity: 2,
                        sku: "SKU-1",
                        title: "Test Shirt",
                        fulfillment_file: new Map([["front", "https://cdn.example/front.png"]]),
                    },
                ],
            }),
        };
        axios.post.mockResolvedValue({ data: { status: true, data: { id: "ON-123" } } });

        const result = await onos.send(order);

        expect(axios.post).toHaveBeenCalledWith(
            "https://api-app.onospod.com/api/v1/order/create",
            expect.objectContaining({ order_id: "ORDER-2" }),
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer test-token",
                },
            }
        );
        expect(result.externalId).toBe("ON-123");
    });

    test("rejects payload before calling Onos when print areas are missing", async () => {
        await expect(
            onos.send({
                toObject: () => ({
                    orderId: "ORDER-3",
                    customer_infor: {
                        name: "Jane Buyer",
                        address: "123 Main St",
                        city: "Boise",
                        state: "ID",
                        zip_code: "83701",
                        country: "US",
                    },
                    items: [{ scale_status: "Complete", quantity: 1, sku: "SKU-1", title: "Test Shirt" }],
                }),
            })
        ).rejects.toMatchObject({
            code: "ONOS_PREVALIDATION_FAILED",
        });

        expect(axios.post).not.toHaveBeenCalled();
    });

    test("blocks production Onos endpoint when NODE_ENV is test", async () => {
        process.env.NODE_ENV = "test";
        process.env.ONOS_CREATE_ORDER_ENDPOINT = "https://api-app.onospod.com/api/v1/order/create";

        await expect(
            onos.send({
                toObject: () => ({
                    orderId: "ORDER-4",
                    customer_infor: {
                        name: "Jane Buyer",
                        address: "123 Main St",
                        city: "Boise",
                        state: "ID",
                        zip_code: "83701",
                        country: "US",
                    },
                    items: [
                        {
                            scale_status: "Complete",
                            quantity: 1,
                            sku: "SKU-1",
                            title: "Test Shirt",
                            fulfillment_file: { front: "https://cdn.example/front.png" },
                        },
                    ],
                }),
            })
        ).rejects.toMatchObject({
            code: "ONOS_UNSAFE_TEST_ENDPOINT",
        });

        expect(axios.post).not.toHaveBeenCalled();
    });
});
