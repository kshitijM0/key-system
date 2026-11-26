"use strict";

// SCHEDULER CORE (replaces the old kmpanel.onrender.com service).
//
// An order is split into "legs". Each leg is one "add order" call to an SMM panel that must happen
// at a given time. Everything is stored in the database, so a restart or a sleeping server never
// loses an order: whenever the server is awake, tick() sends every leg that is due.
//
// This file has no Express and no database code, only plain logic. The database lives behind a
// `store` object (see store-supabase.js; test/scheduler.test.js uses an in-memory store).

const crypto = require("crypto");

const LIMITS = {
  MAX_LEGS_PER_ORDER: 1500,
  MAX_QTY_PER_LEG: 10_000_000,
  MAX_DELAY_MS: 31 * 24 * 60 * 60 * 1000, // 31 days
  MAX_ATTEMPTS: 3,
  RETRY_DELAYS_MS: [2 * 60 * 1000, 5 * 60 * 1000], // wait before attempt 2, before attempt 3
  STUCK_AFTER_MS: 10 * 60 * 1000,
  SEND_TIMEOUT_MS: 30 * 1000,
  SEND_CONCURRENCY: 5,
  DEFAULT_MAX_PER_TICK: 20,
  HISTORY_DAYS: 7,
  ORDERS_SHOWN_DAYS: 30,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ClientError extends Error {
  constructor(message, status) {
    super(message);
    this.clientError = true;
    this.status = status || 400;
  }
}

const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------- validation helpers

// Only public http(s) panels are allowed (blocks localhost / private network addresses).
function isPublicHttpUrl(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (host === "0.0.0.0" || host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

function maskSecret(value) {
  const s = String(value || "");
  return s.length > 8 ? `${s.slice(0, 4)}••••` : "••••";
}

function maskHost(url) {
  try {
    const host = new URL(String(url)).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    const tld = parts.length > 1 ? parts.pop() : "";
    const name = parts.join(".");
    return `${name.slice(0, 3)}••••${tld ? "." + tld : ""}`;
  } catch {
    return "—";
  }
}

function cleanText(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

// Turns the request body into clean values. Returns { error } or { value }.
function validateSchedule(body) {
  if (!body || typeof body !== "object") return { error: "Request body is missing." };

  const name = cleanText(body.name, 100) || "Untitled schedule";
  const link = cleanText(body.link, 500);
  if (!/^https?:\/\/\S+$/i.test(link)) return { error: "A valid link starting with http(s):// is required." };

  if (!Array.isArray(body.legs) || body.legs.length === 0) return { error: "The schedule has no parts (legs)." };
  if (body.legs.length > LIMITS.MAX_LEGS_PER_ORDER) return { error: `Too many parts (max ${LIMITS.MAX_LEGS_PER_ORDER}). Reduce the quantity.` };

  const topBase = cleanText(body.baseUrl, 500);
  const topKey = cleanText(body.apiKey, 300);

  const legs = [];
  for (let i = 0; i < body.legs.length; i++) {
    const raw = body.legs[i] || {};
    const n = i + 1;

    const serviceId = cleanText(raw.serviceId, 60);
    if (!serviceId) return { error: `Part ${n}: no service is selected.` };

    const quantity = Math.floor(Number(raw.quantity));
    if (!Number.isFinite(quantity) || quantity < 1) return { error: `Part ${n}: quantity must be at least 1.` };
    if (quantity > LIMITS.MAX_QTY_PER_LEG) return { error: `Part ${n}: quantity is too large.` };

    const fireInMs = Number(raw.fireInMs);
    if (!Number.isFinite(fireInMs) || fireInMs < 0) return { error: `Part ${n}: invalid delivery time.` };
    if (fireInMs > LIMITS.MAX_DELAY_MS) return { error: `Part ${n}: delivery time is more than 31 days away.` };

    const baseUrl = cleanText(raw.baseUrl, 500) || topBase;
    if (!isPublicHttpUrl(baseUrl)) return { error: `Part ${n}: the panel API URL is missing or not a public http(s) address.` };

    const apiKey = cleanText(raw.apiKey, 300) || topKey;
    if (!apiKey) return { error: `Part ${n}: the panel API key is missing.` };

    const legLink = cleanText(raw.link, 500) || link;
    if (!/^https?:\/\/\S+$/i.test(legLink)) return { error: `Part ${n}: invalid link.` };

    legs.push({
      serviceId,
      quantity,
      fireInMs: Math.round(fireInMs),
      baseUrl,
      apiKey,
      link: legLink,
      category: cleanText(raw.category, 30).toLowerCase() || "other",
      serviceLabel: cleanText(raw.serviceLabel, 80),
      comments: raw.comments ? String(raw.comments).slice(0, 50000) : "",
    });
  }
  return { value: { name, link, legs, topBase, topKey } };
}

// ---------------------------------------------------------------- scheduling

async function scheduleOrder({ store, encrypt, body, now = Date.now() }) {
  const checked = validateSchedule(body);
  if (checked.error) throw new ClientError(checked.error);
  const { name, link, legs, topBase, topKey } = checked.value;

  const orderId = crypto.randomUUID();
  const encCache = new Map(); // same key -> encrypt once
  const encFor = (key) => {
    if (!encCache.has(key)) encCache.set(key, encrypt(key));
    return encCache.get(key);
  };

  const byCategory = {};
  let totalQuantity = 0;
  const legRows = legs.map((l) => {
    byCategory[l.category] = (byCategory[l.category] || 0) + l.quantity;
    totalQuantity += l.quantity;
    return {
      id: crypto.randomUUID(),
      order_id: orderId,
      service_id: l.serviceId,
      link: l.link,
      quantity: l.quantity,
      category: l.category,
      service_label: l.serviceLabel || null,
      base_url: l.baseUrl,
      api_key_enc: encFor(l.apiKey),
      comments: l.comments || null,
      fire_at: iso(now + l.fireInMs),
      status: "pending",
      attempts: 0,
    };
  });

  const orderRow = {
    id: orderId,
    name,
    link,
    status: "active",
    base_url: topBase || legs[0].baseUrl,
    key_hint: maskSecret(topKey || legs[0].apiKey),
    total_legs: legRows.length,
    done_legs: 0,
    failed_legs: 0,
    total_quantity: totalQuantity,
    by_category: byCategory,
  };

  await store.insertOrder(orderRow, legRows); // all-or-nothing (the store removes the order if legs fail)
  return { scheduled: legRows.length, orderId };
}

// ---------------------------------------------------------------- sending one leg to the panel

const TEMPORARY_RE = /rate.?limit|too many|try again|later|busy|temporar|overload|unavailable|maintenance|timeout|timed out/i;

// Decides whether a failed attempt may be tried again. We only retry when we are sure (or nearly sure)
// the panel did NOT create the order, because a repeated "add" call would charge twice.
function classifyFailure({ message, httpStatus, aborted, networkError }) {
  if (aborted) return { retry: false, error: "Panel did not answer in time. Not retried, to avoid ordering twice. Check the panel." };
  if (networkError) return { retry: true, error: `Could not reach the panel: ${networkError}` };
  if (message) {
    if (TEMPORARY_RE.test(message) && !/not enough|insufficient|invalid key/i.test(message)) return { retry: true, error: String(message).slice(0, 300) };
    return { retry: false, error: String(message).slice(0, 300) };
  }
  if (httpStatus === 429 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
    return { retry: true, error: `Panel answered HTTP ${httpStatus}` };
  }
  return { retry: false, error: `Unexpected panel answer (HTTP ${httpStatus}). Not retried, to avoid ordering twice.` };
}

async function sendLeg(leg, { decrypt, fetchImpl }) {
  let apiKey;
  try {
    apiKey = decrypt(leg.api_key_enc);
  } catch {
    return { ok: false, retry: false, error: "Could not decrypt the stored API key (PROVIDER_ENCRYPTION_KEY changed?)." };
  }
  if (!isPublicHttpUrl(leg.base_url)) return { ok: false, retry: false, error: "Panel URL is not a public http(s) address." };

  const params = new URLSearchParams({
    key: apiKey,
    action: "add",
    service: String(leg.service_id),
    link: leg.link,
    quantity: String(leg.quantity),
  });
  if (leg.comments) params.set("comments", leg.comments);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.SEND_TIMEOUT_MS);
  try {
    const res = await fetchImpl(leg.base_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: controller.signal,
      redirect: "manual", // never follow redirects (also protects against redirects to internal addresses)
    });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, retry: false, error: "The panel API URL redirects somewhere else. Use the final https:// API URL of the panel." };
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }

    if (data && data.error) return { ok: false, ...classifyFailure({ message: String(data.error) }) };
    if (data && (data.order !== undefined || data.order_id !== undefined) && res.ok) {
      return { ok: true, providerOrderId: String(data.order !== undefined ? data.order : data.order_id).slice(0, 80) };
    }
    return { ok: false, ...classifyFailure({ httpStatus: res.status }) };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, ...classifyFailure({ aborted: true }) };
    return { ok: false, ...classifyFailure({ networkError: String((err && err.message) || err).slice(0, 120) }) };
  } finally {
    clearTimeout(timer);
  }
}

// Runs async jobs with a small concurrency limit.
async function runLimited(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------------------------------------------------------------- order counters

async function refreshOrder(store, orderId) {
  const order = await store.getOrder(orderId);
  if (!order) return; // deleted meanwhile
  const done = await store.countLegs(orderId, "done");
  const failed = await store.countLegs(orderId, "failed");
  let status = order.status;
  if (status !== "paused") status = done + failed >= order.total_legs ? "completed" : "active";
  if (done !== order.done_legs || failed !== order.failed_legs || status !== order.status) {
    await store.updateOrder(orderId, { done_legs: done, failed_legs: failed, status });
  }
}

// ---------------------------------------------------------------- the tick: send everything that is due

async function tick({ store, decrypt, fetchImpl = fetch, now = Date.now(), maxLegs = LIMITS.DEFAULT_MAX_PER_TICK }) {
  const touched = new Set();
  const summary = { claimed: 0, done: 0, failed: 0, retried: 0, stuck: 0 };

  // Legs that were claimed but never finished (the server stopped in the middle). We do NOT resend them,
  // because we cannot know if the panel already created the order.
  const stuckOrders = await store.failStuck(
    iso(now - LIMITS.STUCK_AFTER_MS),
    "Server stopped while sending this part. Not resent, to avoid ordering twice. Check the panel."
  );
  stuckOrders.forEach((id) => touched.add(id));
  summary.stuck = stuckOrders.length;

  const legs = await store.claimDue(maxLegs, iso(now));
  summary.claimed = legs.length;

  await runLimited(legs, LIMITS.SEND_CONCURRENCY, async (leg) => {
    const attempt = (leg.attempts || 0) + 1;
    const result = await sendLeg(leg, { decrypt, fetchImpl });
    touched.add(leg.order_id);

    if (result.ok) {
      summary.done++;
      await store.updateLeg(leg.id, { status: "done", done_at: iso(Date.now()), attempts: attempt, provider_order_id: result.providerOrderId, last_error: null });
    } else if (result.retry && attempt < LIMITS.MAX_ATTEMPTS) {
      summary.retried++;
      const wait = LIMITS.RETRY_DELAYS_MS[Math.min(attempt - 1, LIMITS.RETRY_DELAYS_MS.length - 1)];
      await store.updateLeg(leg.id, { status: "pending", fire_at: iso(now + wait), attempts: attempt, last_error: result.error });
    } else {
      summary.failed++;
      await store.updateLeg(leg.id, { status: "failed", attempts: attempt, last_error: result.error });
    }
  });

  for (const orderId of touched) await refreshOrder(store, orderId);
  return summary;
}

// ---------------------------------------------------------------- pause / resume / delete

function requireId(id) {
  if (!UUID_RE.test(String(id))) throw new ClientError("Invalid order id.");
  return String(id);
}

async function setOrderAction(store, rawId, action) {
  const id = requireId(rawId);
  const order = await store.getOrder(id);
  if (!order) throw new ClientError("Order not found.", 404);

  if (action === "pause") {
    if (order.status === "completed") throw new ClientError("This order is already completed.");
    await store.updateOrder(id, { status: "paused" });
    await store.setLegsStatus(id, "pending", "paused");
  } else if (action === "resume") {
    if (order.status !== "paused") throw new ClientError("This order is not paused.");
    await store.setLegsStatus(id, "paused", "pending");
    await store.updateOrder(id, { status: "active" });
    await refreshOrder(store, id);
  } else {
    throw new ClientError("Unknown action.");
  }
  return { ok: true };
}

async function deleteOrder(store, rawId) {
  const id = requireId(rawId);
  await store.deleteOrder(id);
  return { ok: true };
}

// ---------------------------------------------------------------- read models used by the website

async function listOrders(store, { now = Date.now() } = {}) {
  const since = iso(now - LIMITS.ORDERS_SHOWN_DAYS * 86400000);
  const rows = await store.listOrders(50, since);
  return runLimited(rows, 5, async (o) => {
    let nextFireAt = null;
    if (o.status !== "completed") {
      const t = await store.nextFireAt(o.id, o.status === "paused" ? "paused" : "pending");
      nextFireAt = t ? new Date(t).getTime() : null;
    }
    return {
      id: o.id,
      name: o.name,
      link: o.link,
      status: o.status,
      totalLegs: o.total_legs,
      doneLegs: o.done_legs,
      failedLegs: o.failed_legs,
      byCategory: o.by_category || {},
      nextFireAt,
      createdAt: new Date(o.created_at).getTime(),
    };
  });
}

function toDelivery(row) {
  return { timestamp: new Date(row.done_at).getTime(), category: row.category, amount: row.quantity, link: row.link };
}

async function deliveredLog(store, { now = Date.now() } = {}) {
  const rows = await store.recentDone(iso(now - LIMITS.HISTORY_DAYS * 86400000), 200, null);
  return rows.map(toDelivery);
}

async function history(store, link, { now = Date.now() } = {}) {
  const clean = cleanText(link, 500);
  if (!clean) return [];
  const rows = await store.recentDone(iso(now - LIMITS.HISTORY_DAYS * 86400000), 1000, clean);
  return rows
    .map(toDelivery)
    .map(({ timestamp, category, amount }) => ({ timestamp, category, amount }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function activityLog(store) {
  const rows = await store.recentOrders(100);
  return rows.map((o) => ({
    timestamp: new Date(o.created_at).getTime(),
    type: "schedule",
    baseUrl: maskHost(o.base_url),
    apiKey: o.key_hint || "••••",
    totalQuantity: Number(o.total_quantity) || 0,
    legCount: o.total_legs,
    link: o.link,
  }));
}

module.exports = {
  LIMITS,
  ClientError,
  isPublicHttpUrl,
  validateSchedule,
  scheduleOrder,
  sendLeg,
  classifyFailure,
  tick,
  setOrderAction,
  deleteOrder,
  listOrders,
  deliveredLog,
  history,
  activityLog,
  maskHost,
  maskSecret,
};
