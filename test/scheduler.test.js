"use strict";
// Run with:  node --test test/
process.env.PROVIDER_ENCRYPTION_KEY = "test-secret-for-unit-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const core = require("../lib/scheduler/core");
const { encryptSecret, decryptSecret } = require("../lib/crypto");
const { createMemoryStore } = require("./memory-store");

const MIN = 60 * 1000;
const baseBody = (over = {}) => ({
  name: "Reel push",
  link: "https://instagram.com/reel/abc",
  baseUrl: "https://panel.example.com/api/v2",
  apiKey: "SECRETKEY123456",
  legs: [
    { serviceId: "101", quantity: 1000, category: "views", serviceLabel: "Views", fireInMs: 0 },
    { serviceId: "202", quantity: 50, category: "likes", serviceLabel: "Likes", fireInMs: 60 * MIN },
  ],
  ...over,
});

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    const form = Object.fromEntries(new URLSearchParams(String(opts.body)));
    calls.push({ url, form, opts });
    return handler({ url, form, n: calls.length });
  };
  fn.calls = calls;
  return fn;
}
const okFetch = () => fakeFetch(({ n }) => jsonResponse({ order: 9000 + n }));

async function setup(body = baseBody()) {
  const store = createMemoryStore();
  const result = await core.scheduleOrder({ store, encrypt: encryptSecret, body });
  return { store, result };
}

// ---------------------------------------------------------------- validation

test("validate: accepts a normal schedule and falls back to the top-level panel URL and key", () => {
  const body = baseBody();
  body.legs[0].baseUrl = "";
  body.legs[0].apiKey = "";
  const r = core.validateSchedule(body);
  assert.equal(r.error, undefined);
  assert.equal(r.value.legs[0].baseUrl, "https://panel.example.com/api/v2");
  assert.equal(r.value.legs[0].apiKey, "SECRETKEY123456");
});

test("validate: rejects bad input with a clear message", () => {
  assert.match(core.validateSchedule(null).error, /body/i);
  assert.match(core.validateSchedule(baseBody({ link: "not a link" })).error, /link/i);
  assert.match(core.validateSchedule(baseBody({ legs: [] })).error, /no parts/i);
  const b1 = baseBody(); b1.legs[0].serviceId = "";
  assert.match(core.validateSchedule(b1).error, /service/i);
  const b2 = baseBody(); b2.legs[0].quantity = 0;
  assert.match(core.validateSchedule(b2).error, /quantity/i);
  const b3 = baseBody(); b3.legs[0].fireInMs = -5;
  assert.match(core.validateSchedule(b3).error, /time/i);
  const b4 = baseBody({ apiKey: "" });
  assert.match(core.validateSchedule(b4).error, /key/i);
  const many = baseBody({ legs: Array.from({ length: 1501 }, () => ({ serviceId: "1", quantity: 1, fireInMs: 0 })) });
  assert.match(core.validateSchedule(many).error, /too many/i);
});

test("validate: blocks localhost and private-network panel URLs", () => {
  for (const bad of ["http://localhost/api", "http://127.0.0.1/api", "http://10.0.0.5/x", "http://192.168.1.1/x", "http://172.20.0.1/x", "http://169.254.169.254/latest", "http://[::1]/x", "ftp://panel.com", "http://thing.internal/x"]) {
    assert.equal(core.isPublicHttpUrl(bad), false, bad);
    assert.match(core.validateSchedule(baseBody({ baseUrl: bad })).error, /public http/i, bad);
  }
  assert.equal(core.isPublicHttpUrl("https://smmpanel.com/api/v2"), true);
  assert.equal(core.isPublicHttpUrl("http://203.0.113.9/api"), true);
});

// ---------------------------------------------------------------- scheduling

test("scheduleOrder: stores legs, never stores the plain API key, masks the hint", async () => {
  const { store, result } = await setup();
  assert.equal(result.scheduled, 2);
  const order = await store.getOrder(result.orderId);
  assert.equal(order.total_legs, 2);
  assert.equal(order.total_quantity, 1050);
  assert.deepEqual(order.by_category, { views: 1000, likes: 50 });
  assert.equal(order.key_hint, "SECR••••");
  assert.equal(order.status, "active");
  const stored = JSON.stringify([...store._legs.values()]) + JSON.stringify(order);
  assert.ok(!stored.includes("SECRETKEY123456"), "plain API key must not be stored");
  const leg = [...store._legs.values()][0];
  assert.equal(decryptSecret(leg.api_key_enc), "SECRETKEY123456");
});

test("scheduleOrder: invalid input throws a client error and stores nothing", async () => {
  const store = createMemoryStore();
  await assert.rejects(core.scheduleOrder({ store, encrypt: encryptSecret, body: baseBody({ legs: [] }) }), (e) => e.clientError === true);
  assert.equal(store._orders.size, 0);
});

// ---------------------------------------------------------------- tick

test("tick: sends only due legs, in the standard panel format, then completes the order", async () => {
  const { store, result } = await setup();
  const f = okFetch();

  const t1 = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  assert.equal(t1.claimed, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://panel.example.com/api/v2");
  assert.deepEqual(f.calls[0].form, { key: "SECRETKEY123456", action: "add", service: "101", link: "https://instagram.com/reel/abc", quantity: "1000" });
  assert.equal(f.calls[0].opts.method, "POST");

  let order = await store.getOrder(result.orderId);
  assert.equal(order.done_legs, 1);
  assert.equal(order.status, "active");

  // an hour later the second leg is due
  const t2 = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: Date.now() + 61 * MIN });
  assert.equal(t2.claimed, 1);
  order = await store.getOrder(result.orderId);
  assert.equal(order.done_legs, 2);
  assert.equal(order.status, "completed");
  const delivered = [...store._legs.values()].map((l) => l.provider_order_id).sort();
  assert.deepEqual(delivered, ["9001", "9002"]);
});

test("tick: never sends the same leg twice", async () => {
  const { store } = await setup();
  const f = okFetch();
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

test("tick: respects the per-tick limit and picks the rest up next time", async () => {
  const legs = Array.from({ length: 7 }, (_, i) => ({ serviceId: "1", quantity: 10 + i, category: "views", fireInMs: 0 }));
  const { store, result } = await setup(baseBody({ legs }));
  const f = okFetch();
  const a = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, maxLegs: 3 });
  assert.equal(a.claimed, 3);
  const b = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, maxLegs: 10 });
  assert.equal(b.claimed, 4);
  assert.equal((await store.getOrder(result.orderId)).status, "completed");
});

test("tick: passes comments for comment services", async () => {
  const legs = [{ serviceId: "55", quantity: 2, category: "comments", fireInMs: 0, comments: "nice\ngreat" }];
  const { store } = await setup(baseBody({ legs }));
  const f = okFetch();
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  assert.equal(f.calls[0].form.comments, "nice\ngreat");
});

test("tick: temporary panel errors are retried (2 min, then 5 min) and fail after 3 attempts", async () => {
  const { store, result } = await setup(baseBody({ legs: [{ serviceId: "1", quantity: 10, category: "views", fireInMs: 0 }] }));
  const f = fakeFetch(() => jsonResponse({ error: "Rate limit exceeded, try again later" }));
  const t0 = Date.now();

  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: t0 });
  let leg = [...store._legs.values()][0];
  assert.equal(leg.status, "pending");
  assert.equal(leg.attempts, 1);
  assert.equal(new Date(leg.fire_at).getTime(), t0 + 2 * MIN);

  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: t0 + 1 * MIN }); // not due yet
  assert.equal(f.calls.length, 1);

  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: t0 + 3 * MIN });
  leg = [...store._legs.values()][0];
  assert.equal(leg.attempts, 2);
  assert.equal(new Date(leg.fire_at).getTime(), t0 + 3 * MIN + 5 * MIN);

  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: t0 + 9 * MIN });
  leg = [...store._legs.values()][0];
  assert.equal(leg.status, "failed");
  assert.equal(leg.attempts, 3);
  const order = await store.getOrder(result.orderId);
  assert.equal(order.failed_legs, 1);
  assert.equal(order.status, "completed");
  assert.match(leg.last_error, /rate limit/i);
});

test("tick: permanent errors fail at once, never retried", async () => {
  for (const msg of ["Invalid API key", "Not enough funds on balance", "Incorrect link", "Service not found"]) {
    const { store } = await setup(baseBody({ legs: [{ serviceId: "1", quantity: 10, category: "views", fireInMs: 0 }] }));
    const f = fakeFetch(() => jsonResponse({ error: msg }));
    await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
    const leg = [...store._legs.values()][0];
    assert.equal(leg.status, "failed", msg);
    assert.equal(leg.attempts, 1, msg);
  }
});

test("tick: no double ordering when the outcome is unclear (timeout, odd answer, redirect)", async () => {
  const cases = {
    timeout: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; },
    "odd answer": async () => jsonResponse({ hello: "world" }),
    redirect: async () => ({ ok: false, status: 301, text: async () => "" }),
    "html page": async () => ({ ok: true, status: 200, text: async () => "<html>Cloudflare</html>" }),
  };
  for (const [name, handler] of Object.entries(cases)) {
    const { store } = await setup(baseBody({ legs: [{ serviceId: "1", quantity: 10, category: "views", fireInMs: 0 }] }));
    const f = fakeFetch(handler);
    await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
    const leg = [...store._legs.values()][0];
    assert.equal(leg.status, "failed", name);
    assert.equal(f.calls.length, 1, name);
  }
});

test("tick: a network failure (panel unreachable) is retried", async () => {
  const { store } = await setup(baseBody({ legs: [{ serviceId: "1", quantity: 10, category: "views", fireInMs: 0 }] }));
  const f = fakeFetch(async () => { throw new Error("fetch failed"); });
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  const leg = [...store._legs.values()][0];
  assert.equal(leg.status, "pending");
  assert.match(leg.last_error, /could not reach/i);
});

test("tick: legs stuck in 'processing' are failed, not resent", async () => {
  const { store, result } = await setup(baseBody({ legs: [{ serviceId: "1", quantity: 10, category: "views", fireInMs: 0 }] }));
  const stuckLeg = [...store._legs.values()][0];
  stuckLeg.status = "processing"; // claimed 30 minutes ago and never finished (server stopped mid-send)
  stuckLeg.claimed_at = new Date(Date.now() - 30 * MIN).toISOString();
  const f = okFetch();
  const r = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  assert.equal(r.stuck, 1);
  assert.equal(f.calls.length, 0);
  const order = await store.getOrder(result.orderId);
  assert.equal(order.failed_legs, 1);
  assert.equal(order.status, "completed");
});

test("tick: a wrong encryption key fails the leg with a clear message instead of crashing", async () => {
  const { store } = await setup(baseBody({ legs: [{ serviceId: "1", quantity: 10, category: "views", fireInMs: 0 }] }));
  const f = okFetch();
  await core.tick({ store, decrypt: () => { throw new Error("bad decrypt"); }, fetchImpl: f });
  const leg = [...store._legs.values()][0];
  assert.equal(leg.status, "failed");
  assert.match(leg.last_error, /decrypt/i);
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------- pause / resume / delete

test("pause stops sending; resume sends the overdue parts again", async () => {
  const { store, result } = await setup();
  const f = okFetch();
  await core.setOrderAction(store, result.orderId, "pause");
  assert.equal((await store.getOrder(result.orderId)).status, "paused");
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  assert.equal(f.calls.length, 0);

  await assert.rejects(core.setOrderAction(store, result.orderId, "pause").then(() => core.setOrderAction(store, result.orderId, "bogus")), (e) => e.clientError);
  await core.setOrderAction(store, result.orderId, "resume");
  assert.equal((await store.getOrder(result.orderId)).status, "active");
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

test("resume on an order that is not paused, and bad ids, are rejected", async () => {
  const { store, result } = await setup();
  await assert.rejects(core.setOrderAction(store, result.orderId, "resume"), /not paused/);
  await assert.rejects(core.setOrderAction(store, "not-a-uuid", "pause"), /Invalid order id/);
  await assert.rejects(core.setOrderAction(store, "11111111-1111-4111-8111-111111111111", "pause"), /not found/i);
  await assert.rejects(core.deleteOrder(store, "1; drop table"), /Invalid order id/);
});

test("delete removes the order and its parts", async () => {
  const { store, result } = await setup();
  await core.deleteOrder(store, result.orderId);
  assert.equal(store._orders.size, 0);
  assert.equal(store._legs.size, 0);
});

// ---------------------------------------------------------------- what the website reads

test("listOrders: exactly the shape script.js expects", async () => {
  const { store, result } = await setup();
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: okFetch() });
  const list = await core.listOrders(store);
  assert.equal(list.length, 1);
  const o = list[0];
  assert.equal(o.id, result.orderId);
  assert.equal(o.name, "Reel push");
  assert.equal(o.status, "active"); // style.css knows: active / paused / completed
  assert.equal(o.totalLegs, 2);
  assert.equal(o.doneLegs, 1);
  assert.equal(o.failedLegs, 0);
  assert.deepEqual(o.byCategory, { views: 1000, likes: 50 });
  assert.equal(typeof o.nextFireAt, "number");
  assert.ok(o.nextFireAt > Date.now());
});

test("history, delivered-log and activity-log give the shapes the Tracker and Logs tabs read", async () => {
  const { store } = await setup();
  await core.tick({ store, decrypt: decryptSecret, fetchImpl: okFetch() });

  const hist = await core.history(store, "https://instagram.com/reel/abc");
  assert.equal(hist.length, 1);
  assert.deepEqual(Object.keys(hist[0]).sort(), ["amount", "category", "timestamp"]);
  assert.equal(hist[0].amount, 1000);
  assert.equal(hist[0].category, "views");
  assert.deepEqual(await core.history(store, "https://other.com/x"), []);
  assert.deepEqual(await core.history(store, ""), []);

  const log = await core.deliveredLog(store);
  assert.equal(log.length, 1);
  assert.deepEqual(Object.keys(log[0]).sort(), ["amount", "category", "link", "timestamp"]);

  const act = await core.activityLog(store);
  assert.equal(act.length, 1);
  assert.equal(act[0].type, "schedule");
  assert.equal(act[0].totalQuantity, 1050);
  assert.equal(act[0].legCount, 2);
  assert.equal(act[0].apiKey, "SECR••••"); // never the real key
  assert.ok(!act[0].baseUrl.includes("panel.example"), "panel host is masked");
  assert.ok(!JSON.stringify(act).includes("SECRETKEY123456"));
});

// ---------------------------------------------------------------- HTTP routes (with a fake app, no Express needed)

test("routes: every URL the website calls is registered and answers like the old service", async () => {
  const store = createMemoryStore();
  const runtimePath = require.resolve("../lib/scheduler/runtime");
  const storePath = require.resolve("../lib/scheduler/store-supabase");
  require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: { createSupabaseStore: () => store } };
  delete require.cache[runtimePath];
  delete require.cache[require.resolve("../lib/scheduler/routes")];
  const routes = require("../lib/scheduler/routes");

  const registered = [];
  const app = {};
  for (const verb of ["get", "post", "delete", "all", "use"]) app[verb] = (p, ...h) => registered.push({ verb, path: p, handler: h[h.length - 1] });
  routes.mount(app);

  const has = (verb, p) => registered.some((r) => r.verb === verb && r.path === p);
  assert.ok(has("post", "/schedule-order"));
  assert.ok(has("get", "/orders"));
  assert.ok(has("delete", "/orders/:id"));
  assert.ok(has("post", "/orders/:id/:action"));
  assert.ok(has("get", "/history"));
  assert.ok(has("get", "/delivered-log"));
  assert.ok(has("get", "/activity-log"));
  assert.ok(has("all", "/tick"));

  const call = async (verb, p, req = {}) => {
    const out = { status: 200, body: undefined, headers: {} };
    const res = {
      headersSent: false,
      status(c) { out.status = c; return this; },
      json(b) { out.body = b; this.headersSent = true; return this; },
      setHeader(k, v) { out.headers[k] = v; },
      sendStatus(c) { out.status = c; this.headersSent = true; },
    };
    const r = registered.find((x) => x.verb === verb && x.path === p);
    await r.handler({ headers: {}, socket: { remoteAddress: "1.2.3.4" }, query: {}, params: {}, body: {}, ...req }, res);
    return out;
  };

  const bad = await call("post", "/schedule-order", { body: { link: "x" } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error);

  const good = await call("post", "/schedule-order", { body: baseBody() });
  assert.equal(good.status, 200);
  assert.equal(good.body.scheduled, 2);

  const listed = await call("get", "/orders");
  assert.equal(listed.body.length, 1);
  const id = listed.body[0].id;

  const paused = await call("post", "/orders/:id/:action", { params: { id, action: "pause" } });
  assert.deepEqual(paused.body, { ok: true });
  const bogus = await call("post", "/orders/:id/:action", { params: { id, action: "explode" } });
  assert.equal(bogus.status, 400);
  const gone = await call("delete", "/orders/:id", { params: { id } });
  assert.deepEqual(gone.body, { ok: true });
  assert.equal((await call("get", "/orders")).body.length, 0);

  // CORS: GitHub Pages and the Render site are allowed, strangers are not
  const corsFn = registered.find((r) => r.verb === "use" && r.path === "/orders").handler;
  const hdr = {};
  corsFn({ headers: { origin: "https://kshitijm0.github.io" }, method: "GET" }, { setHeader: (k, v) => { hdr[k] = v; } }, () => {});
  assert.equal(hdr["Access-Control-Allow-Origin"], "https://kshitijm0.github.io");
  const hdr2 = {};
  corsFn({ headers: { origin: "https://evil.example" }, method: "GET" }, { setHeader: (k, v) => { hdr2[k] = v; } }, () => {});
  assert.equal(hdr2["Access-Control-Allow-Origin"], undefined);
  const pre = { code: null };
  corsFn({ headers: { origin: "https://kshitijm0.github.io" }, method: "OPTIONS" }, { setHeader() {}, sendStatus: (c) => { pre.code = c; } }, () => {});
  assert.equal(pre.code, 204);
});
