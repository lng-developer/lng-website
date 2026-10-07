const axios = require("axios");
const mongoose = require("mongoose");
const db = require("../models");
const { applyTrackingSync, buildTrackingSync, matchesShipmentTracking, recentShipments, trackingLookupValues } = require("./viettelPostTracking.service");

function credentials() {
  const clientId = String(process.env.VIETTELPOST_CLIENT_ID || process.env.client_id || "").trim();
  const clientSecret = String(process.env.VIETTELPOST_CLIENT_SECRET || process.env.client_secret || "").trim();
  if (!clientId || !clientSecret) throw new Error("Missing VIETTELPOST_CLIENT_ID/VIETTELPOST_CLIENT_SECRET");
  return { clientId, clientSecret };
}

async function accessToken(clientId, clientSecret) {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const response = await axios.post("https://auth-global.viettelpost.vn/connect/token", body, { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, timeout: 20000 });
  if (!response.data?.access_token) throw new Error("Viettel Post did not return an access token");
  return response.data.access_token;
}

function api(token) {
  return axios.create({ baseURL: "https://api-global.viettelpost.vn/gateway", timeout: 20000, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", timezone: "420" } });
}

async function listRecentShipments(client, since, max) {
  const shipments = [];
  for (let skip = 0; shipments.length < max; skip += 100) {
    const response = await client.get("/api/partner/order/shipment", { params: { SkipCount: skip, MaxResultCount: Math.min(100, max - shipments.length) } });
    const data = response.data?.data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    shipments.push(...items);
    if (!items.length || shipments.length >= Number(data.totalCount || 0)) break;
  }
  return recentShipments(shipments, since);
}

function matchingShipment(order, shipments) {
  for (const item of order.items || []) {
    const shipment = shipments.find((candidate) => matchesShipmentTracking(candidate.trackingNumber, item?.tracking_info?.tracking));
    if (shipment) return shipment;
  }
  return null;
}

async function runViettelPostTrackingSync({ sinceDays = 7, max = 1000, apply = false } = {}) {
  if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > 31) throw new Error("sinceDays must be an integer between 1 and 31");
  if (!Number.isInteger(max) || max < 1 || max > 5000) throw new Error("max must be an integer between 1 and 5000");
  const since = new Date(Date.now() - sinceDays * 86400000);
  const { clientId, clientSecret } = credentials();
  const token = await accessToken(clientId, clientSecret);
  const shipments = (await listRecentShipments(api(token), since, max)).filter((shipment) => shipment?.trackingNumber);
  const lookupValues = trackingLookupValues(shipments.map((shipment) => shipment.trackingNumber));
  const openedConnection = mongoose.connection.readyState === 0;
  if (openedConnection) await db.connectDB();
  try {
    const query = { "items.tracking_info.tracking": { $in: lookupValues } };
    const projection = "orderId items vendor_submissions";
    const [amazonOrders, etsyOrders] = await Promise.all([db.orderCustomProduct.find(query).select(projection), db.EtsyOrder.find(query).select(projection)]);
    const candidates = [...amazonOrders.map((order) => ({ source: "amazon", order })), ...etsyOrders.map((order) => ({ source: "etsy", order }))];
    const details = new Map();
    const summary = { mode: apply ? "apply" : "dry-run", since: since.toISOString(), shipments: shipments.length, candidates: candidates.length, matched: 0, wouldUpdate: 0, updated: 0, samples: [] };
    for (const candidate of candidates) {
      const shipment = matchingShipment(candidate.order, shipments);
      if (!shipment) continue;
      if (!details.has(shipment.id)) details.set(shipment.id, (await api(token).get(`/api/partner/order/shipment/${shipment.id}`)).data?.data || {});
      const sync = buildTrackingSync(shipment, details.get(shipment.id));
      const result = applyTrackingSync(candidate.order, sync);
      summary.matched += result.matchedItems;
      if (!result.changed) continue;
      summary.wouldUpdate += 1;
      if (summary.samples.length < 20) summary.samples.push({ source: candidate.source, orderId: candidate.order.orderId, shipmentCode: sync.shipmentCode, carrier: sync.carrier || null, actualShipAt: sync.actualShipAt || null, changedItems: result.changedItems });
      if (apply) {
        candidate.order.markModified("items");
        candidate.order.markModified("vendor_submissions");
        await candidate.order.save();
        summary.updated += 1;
      }
    }
    return summary;
  } finally {
    if (openedConnection) await mongoose.disconnect();
  }
}

module.exports = { runViettelPostTrackingSync };
