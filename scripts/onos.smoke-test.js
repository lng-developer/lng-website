require("../src/config/env.config")();

const onos = require("../src/service/fulfillment/providers/onos");

const shouldSend = process.argv.includes("--send");
const allowProductionEndpoint = process.argv.includes("--allow-production-endpoint");
if (allowProductionEndpoint) {
  process.env.ONOS_ALLOW_PRODUCTION_ENDPOINT_IN_TEST = "true";
}

const fakeOrder = {
  toObject: () => ({
    orderId: `TEST-ONOS-${Date.now()}`,
    shipping_type: "Standard",
    customer_infor: {
      name: "Onos Test Buyer",
      address: "9701 W Beacon Light Rd",
      address_2: "",
      city: "Star",
      state: "ID",
      zip_code: "83669-5109",
      country: "US",
      email: "test@example.com",
      phone_number: "+1 929-436-4790",
    },
    items: [
      {
        scale_status: "Complete",
        quantity: 1,
        sku: "HW-SHIRT-AS-DESIGN-L",
        title: "US Hawaii Shirt",
        baseImage: {
          imageUrl: "https://printio-widget-live.s3.amazonaws.com/60053311-311E-4DB8-B32D-B59C72754C2E.jpg",
        },
        fulfillment_file: {
          front: "https://printio-widget-live.s3.amazonaws.com/60053311-311E-4DB8-B32D-B59C72754C2E.jpg",
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
  }),
};

async function main() {
  const orderObj = fakeOrder.toObject();
  const payload = onos._helpers.buildPayload(orderObj);
  const validation = onos._helpers.validatePayload(payload);

  console.log("[ONOS_SMOKE] Endpoint:", process.env.ONOS_CREATE_ORDER_ENDPOINT);
  console.log("[ONOS_SMOKE] Payload:");
  console.log(JSON.stringify(payload, null, 2));

  if (!validation.ok) {
    console.error("[ONOS_SMOKE] Payload invalid:");
    validation.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log("[ONOS_SMOKE] Payload valid.");

  if (!shouldSend) {
    console.log("[ONOS_SMOKE] Dry run only. Add --send to call Onos.");
    return;
  }

  const endpoint = String(process.env.ONOS_CREATE_ORDER_ENDPOINT || "");
  if (!allowProductionEndpoint && !endpoint.includes("/order/create/test")) {
    console.error("[ONOS_SMOKE] Refusing to send because endpoint is not Onos test endpoint.");
    console.error("[ONOS_SMOKE] Use ONOS_CREATE_ORDER_ENDPOINT=/order/create/test or pass --allow-production-endpoint.");
    process.exitCode = 1;
    return;
  }

  const result = await onos.send(fakeOrder);
  console.log("[ONOS_SMOKE] Onos accepted request:");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("[ONOS_SMOKE] Failed:");
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  if (error.vendorResponse) console.error(JSON.stringify(error.vendorResponse, null, 2));
  process.exitCode = 1;
});
