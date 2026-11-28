"use strict";
// What happens when the server was asleep and many parts are overdue: they must go out slowly, never as one burst.
process.env.PROVIDER_ENCRYPTION_KEY = "test-secret-for-unit-tests";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/scheduler/core");
const { encryptSecret, decryptSecret } = require("../lib/crypto");
const { createMemoryStore } = require("./memory-store");

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const okFetch = () => {
  const calls = [];
  const fn = async (url, opts) => { calls.push(Object.fromEntries(new URLSearchParams(String(opts.body)))); return { ok: true, status: 200, text: async () => JSON.stringify({ order: calls.length }) }; };
  fn.calls = calls;
  return fn;
};

// Creates an order "as of" a past moment, so its parts are already overdue "now".
async function makeOrder(store, { startedAt, legsCount, spreadMs, link = "https://x.com/a", service = "1" }) {
  const legs = Array.from({ length: legsCount }, (_, i) => ({ serviceId: service, quantity: 100, category: "views", fireInMs: Math.floor((i / legsCount) * spreadMs) }));
  return core.scheduleOrder({
    store, encrypt: encryptSecret, now: startedAt,
    body: { name: "o", link, baseUrl: "https://panel.example.com/api", apiKey: "KEY123456789", legs },
  });
}

test("after a long sleep, overdue parts go out one at a time, not as a burst", async () => {
  const store = createMemoryStore();
  const lateState = new Map();
  const f = okFetch();
  const T = Date.now();
  await makeOrder(store, { startedAt: T - 8 * HOUR, legsCount: 60, spreadMs: 7.5 * HOUR }); // all 60 parts are overdue now

  const run = (at) => core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: at, lateState });

  assert.equal((await run(T)).claimed, 1, "first tick after waking sends exactly one");
  assert.equal((await run(T + 20 * SEC)).claimed, 0, "20 s later: still waiting");
  assert.equal((await run(T + 40 * SEC)).claimed, 1, "40 s later: the next one");
  assert.equal(f.calls.length, 2);
});

test("a backlog drains steadily and never faster than one part per order every 40 s", async () => {
  const store = createMemoryStore();
  const lateState = new Map();
  const f = okFetch();
  const T = Date.now();
  await makeOrder(store, { startedAt: T - 6 * HOUR, legsCount: 30, spreadMs: 5 * HOUR });

  const sentAt = [];
  for (let i = 0; i < 200; i++) {
    const at = T + i * 20 * SEC;
    const r = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: at, lateState });
    for (let k = 0; k < r.claimed; k++) sentAt.push(at);
  }
  assert.equal(sentAt.length, 30, "everything is delivered in the end");
  for (let i = 1; i < sentAt.length; i++) assert.ok(sentAt[i] - sentAt[i - 1] >= 40 * SEC, "gap between parts is at least 40 s");
});

test("parts that are on time are never held back by another order's backlog", async () => {
  const store = createMemoryStore();
  const lateState = new Map();
  const f = okFetch();
  const T = Date.now();
  await makeOrder(store, { startedAt: T - 8 * HOUR, legsCount: 80, spreadMs: 7.5 * HOUR, link: "https://x.com/backlog" });
  await makeOrder(store, { startedAt: T - 5 * SEC, legsCount: 3, spreadMs: 1, link: "https://x.com/fresh" }); // due right now

  const r = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: T, lateState });
  const links = f.calls.map((c) => c.link).sort();
  assert.equal(r.claimed, 4);
  assert.equal(links.filter((l) => l === "https://x.com/fresh").length, 3, "all 3 on-time parts went out");
  assert.equal(links.filter((l) => l === "https://x.com/backlog").length, 1, "only one backlog part");
});

test("each order gets its own catch-up slot", async () => {
  const store = createMemoryStore();
  const lateState = new Map();
  const f = okFetch();
  const T = Date.now();
  await makeOrder(store, { startedAt: T - 8 * HOUR, legsCount: 20, spreadMs: 7 * HOUR, link: "https://x.com/one" });
  await makeOrder(store, { startedAt: T - 8 * HOUR, legsCount: 20, spreadMs: 7 * HOUR, link: "https://x.com/two" });
  const r = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: T, lateState });
  assert.equal(r.claimed, 2);
  assert.deepEqual(f.calls.map((c) => c.link).sort(), ["https://x.com/one", "https://x.com/two"]);
});

test("a part that is only a little overdue (under 3 minutes) is still sent normally", async () => {
  const store = createMemoryStore();
  const lateState = new Map();
  const f = okFetch();
  const T = Date.now();
  await makeOrder(store, { startedAt: T - 2 * MIN, legsCount: 5, spreadMs: 1 }); // all 5 due 2 minutes ago
  const r = await core.tick({ store, decrypt: decryptSecret, fetchImpl: f, now: T, lateState });
  assert.equal(r.claimed, 5);
  assert.equal(r.late, 0);
});
