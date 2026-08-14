jest.mock("axios", () => ({
  post: jest.fn(),
}));

const axios = require("axios");
const lng = require("../lng");

describe("lng fulfillment provider", () => {
  const oldEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...oldEnv,
      FULFILLMENT_API_BASE_URL: "https://platform.example/",
      FULFILLMENT_TENANT_API_KEY: "tenant-key",
      LNG_ENDPOINT: "https://api-fulfillment.lngmerch.co/api/orders",
      LNG_API_KEY: "legacy-key",
    };
  });

  afterAll(() => {
    process.env = oldEnv;
  });

  test("uses Fulfillment Platform v2 instead of legacy LNG endpoint when configured", async () => {
    axios.post.mockResolvedValueOnce({ data: { success: true, inserted: 1 } });

    await lng.send({
      orderId: "111-0841935-2771406",
      customer_infor: { name: "Jane Buyer", country: "US" },
      items: [{ orderItemId: "ITEM-1", quantity: 1, fulfillment_file: { front: "https://cdn.example/front.png" } }],
    });

    expect(axios.post).toHaveBeenCalledWith(
      "https://platform.example/api/portal/orders",
      expect.objectContaining({
        data: [
          expect.objectContaining({
            orderId: "111-0841935-2771406",
            source: "portal",
            sourceChannel: "AMAZON",
          }),
        ],
      }),
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tenant-key",
        },
      }
    );
  });
});
