#!/usr/bin/env node
// Usage: node scripts/viettel-post.syncTracking.js [--since-days 7] [--max 1000] [--apply]

const axios = require("axios");
const mongoose = require("mongoose");
const loadEnv = require("../src/config/env.config");
const db = require("../src/models");
const {
  applyTrackingSync,
  buildTrackingSync,
  matchesShipmentTracking,
  recentShipments,
  trackingLookupValues,
} = require("../src/service/viettelPostTracking.service");

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return !value || value.startsWith("--") ? fallback : value;
}

function boundedNumber(name, fallback, min, max) {
  const value = Number(flag(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function credentials() {
  const clientId = String(process.env.VIETTELPOST_CLIENT_ID || process.env.client_id || "").trim();
  const clientSecret = String(process.env.VIETTELPOST_CLIENT_SECRET || process.env.client_secret || "").trim();
  if (!clientId || !clientSecret) throw new Error("Missing VIETTELPOST_CLIENT_ID/VIETTELPOST_CLIENT_SECRET");
  return { clientId, clientSecret };
}

async function accessToken(clientId, clientSecret) {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const response = await axios.post("https://auth-global.viettelpost.vn/connect/token", body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    timeout: 20000,
  });
  if (!response.data?.access_token) throw new Error("Viettel Post did not return an access token");
  return response.data.access_token;
}

function api(token) {
  return axios.create({
    baseURL: "https://api-global.viettelpost.vn/gateway",
    timeout: 20000,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", timezone: "420" },
  });
}

async function listRecentShipments(client, since, max) {
  const shipments = [];
  const pageSize = 100;
  for (let skip = 0; shipments.length < max; skip += pageSize) {
    const response = await client.get("/api/partner/order/shipment", {
      params: {
        SkipCount: skip,
        MaxResultCount: Math.min(pageSize, max - shipments.length),
      },
    });
    const data = response.data?.data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    shipments.push(...items);
    if (!items.length || shipments.length >= Number(data.totalCount || 0)) break;
  }
  return recentShipments(shipments, since);
}

function matchingShipment(order, shipments) {
  for (const item of order.items || []) {
    const localTracking = item?.tracking_info?.tracking;
    const shipment = shipments.find((candidate) => matchesShipmentTracking(candidate.trackingNumber, localTracking));
    if (shipment) return shipment;
  }
  return null;
}

async function run() {
  loadEnv();
  const sinceDays = boundedNumber("--since-days", 7, 1, 31);
  const max = boundedNumber("--max", 1000, 1, 5000);
  const apply = argv.includes("--apply");
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const { clientId, clientSecret } = credentials();
  const token = await accessToken(clientId, clientSecret);
  const shipments = (await listRecentShipments(api(token), since, max)).filter((shipment) => shipment?.trackingNumber);
  const lookupValues = trackingLookupValues(shipments.map((shipment) => shipment.trackingNumber));

  const query = { "items.tracking_info.tracking": { $in: lookupValues } };
  const projection = "orderId items vendor_submissions";
  await db.connectDB();
  try {
    const [amazonOrders, etsyOrders] = await Promise.all([
      db.orderCustomProduct.find(query).select(projection),
      db.EtsyOrder.find(query).select(projection),
    ]);
    const candidates = [
      ...amazonOrders.map((order) => ({ source: "amazon", order })),
      ...etsyOrders.map((order) => ({ source: "etsy", order })),
    ];
    const details = new Map();
    const summary = { mode: apply ? "apply" : "dry-run", since: since.toISOString(), shipments: shipments.length, candidates: candidates.length, matched: 0, wouldUpdate: 0, updated: 0, samples: [] };

    for (const candidate of candidates) {
      const shipment = matchingShipment(candidate.order, shipments);
      if (!shipment) continue;
      if (!details.has(shipment.id)) {
        const response = await api(token).get(`/api/partner/order/shipment/${shipment.id}`);
        details.set(shipment.id, response.data?.data || {});
      }
      const sync = buildTrackingSync(shipment, details.get(shipment.id));
      const result = applyTrackingSync(candidate.order, sync);
      summary.matched += result.matchedItems;
      if (!result.changed) continue;
      summary.wouldUpdate += 1;
      if (summary.samples.length < 20) {
        summary.samples.push({ source: candidate.source, orderId: candidate.order.orderId, shipmentCode: sync.shipmentCode, carrier: sync.carrier || null, actualShipAt: sync.actualShipAt || null, changedItems: result.changedItems });
      }
      if (apply) {
        candidate.order.markModified("items");
        candidate.order.markModified("vendor_submissions");
        await candidate.order.save();
        summary.updated += 1;
      }
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
