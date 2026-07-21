const { shopifyGraphQL } = require("./shopifyClient.service");

const ORDER_CANCEL_MUTATION = `
    mutation OrderCancel(
        $orderId: ID!
        $notifyCustomer: Boolean
        $refundMethod: OrderCancelRefundMethodInput!
        $restock: Boolean!
        $reason: OrderCancelReason!
        $staffNote: String
    ) {
        orderCancel(
            orderId: $orderId
            notifyCustomer: $notifyCustomer
            refundMethod: $refundMethod
            restock: $restock
            reason: $reason
            staffNote: $staffNote
        ) {
            job {
                id
                done
            }
            orderCancelUserErrors {
                field
                message
                code
            }
            userErrors {
                field
                message
            }
        }
    }
`;

const VALID_CANCEL_REASONS = new Set([
    "CUSTOMER",
    "DECLINED",
    "FRAUD",
    "INVENTORY",
    "STAFF",
    "OTHER",
]);

function normalizeCancelReason(reason) {
    const text = String(reason || "OTHER").trim().toUpperCase();
    return VALID_CANCEL_REASONS.has(text) ? text : "OTHER";
}

async function cancelShopifyOrder({
    orderGid,
    reason = "OTHER",
    notifyCustomer = false,
    restock = false,
    refundOriginalPayment = false,
    staffNote = "",
} = {}) {
    if (!orderGid) {
        const err = new Error("Missing Shopify order gid");
        err.code = "SHOPIFY_ORDER_GID_MISSING";
        throw err;
    }

    const data = await shopifyGraphQL(ORDER_CANCEL_MUTATION, {
        orderId: orderGid,
        notifyCustomer: Boolean(notifyCustomer),
        refundMethod: {
            originalPaymentMethodsRefund: Boolean(refundOriginalPayment),
        },
        restock: Boolean(restock),
        reason: normalizeCancelReason(reason),
        staffNote: staffNote ? String(staffNote).slice(0, 255) : null,
    });

    const payload = data?.orderCancel || {};
    const errors = [
        ...(Array.isArray(payload.orderCancelUserErrors) ? payload.orderCancelUserErrors : []),
        ...(Array.isArray(payload.userErrors) ? payload.userErrors : []),
    ].filter((error) => error?.message);

    if (errors.length) {
        const err = new Error(errors.map((error) => error.message).join("; "));
        err.code = "SHOPIFY_ORDER_CANCEL_FAILED";
        err.shopifyErrors = errors;
        throw err;
    }

    return {
        job: payload.job || null,
    };
}

module.exports = {
    cancelShopifyOrder,
    normalizeCancelReason,
};
