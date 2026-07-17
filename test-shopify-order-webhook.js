const crypto = require("crypto");
const axios = require("axios");

require("./src/config/env.config")();


const secret = process.env.SHOPIFY_CLIENT_SECRET;


if (!secret) {
    throw new Error(
        "Missing SHOPIFY_CLIENT_SECRET"
    );
}


const payload = {
    id: 999999,

    name: "#TEST-PROD-WEBHOOK-001",

    email: "test@lngmerch.com",

    phone: "+10000000000",

    financial_status: "paid",

    fulfillment_status: null,

    currency: "USD",

    total_price: "25.00",

    presentment_currency: "USD",


    customer: {
        id: 123456,

        email: "test@lngmerch.com",

        first_name: "John",

        last_name: "Smith"
    },


    shipping_address: {
        first_name: "John",

        last_name: "Smith",

        address1: "123 Test Street",

        address2: "",

        city: "New York",

        province: "NY",

        zip: "10001",

        country: "United States",

        country_code: "US",

        phone:"+10000000000"
    },


    line_items: [

        {
            id: 888888,

            title:
            "Custom Wedding Napkin",

            name:
            "Custom Wedding Napkin",

            sku:
            "NAPKIN-001",

            quantity: 10,

            price:"2.50",

            variant_title:"White",


            properties:[

                {
                    name:"Name",

                    value:
                    "John & Sarah"
                },

                {
                    name:"Wedding Date",

                    value:
                    "July 20 2026"
                }

            ]
        }

    ]
};


const rawBody =
    JSON.stringify(payload);


const hmac =
    crypto
    .createHmac(
        "sha256",
        secret
    )
    .update(rawBody, "utf8")
    .digest("base64");


console.log(
    "SHOPIFY SECRET LENGTH:",
    secret.length
);


console.log(
    "HMAC:",
    hmac
);


axios.post(

    "https://api.lngmerch.co/api/shopify/webhooks/orders-create",

    rawBody,

    {
        headers:{

            "Content-Type":
            "application/json",


            "X-Shopify-Hmac-Sha256":
            hmac,


            "X-Shopify-Topic":
            "orders/create",


            "X-Shopify-Shop-Domain":
            "d1xx0b-aq.myshopify.com"

        },

        timeout:30000

    }

)

.then(res=>{

    console.log(
        "SUCCESS"
    );

    console.log(
        res.data
    );

})


.catch(err=>{

    console.log(
        "FAILED"
    );


    console.log(
        err.response?.data ||
        err.message
    );

});