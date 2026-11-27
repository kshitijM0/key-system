"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { proxyHandler } = require("../lib/panelProxy");

function run(body, fetchImpl, ip = "9.9.9.9") {
  const out = { status: 200, body: undefined };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  const req = { body, headers: { "x-forwarded-for": ip }, socket: {} };
  return proxyHandler(req, res, fetchImpl).then(() => out);
}
const reply = (text, status = 200) => async () => ({ status, text: async () => text });

test("proxy: forwards the call as a form post and returns the panel JSON (services array)", async () => {
  let seen;
  const f = async (url, opts) => { seen = { url, opts, form: Object.fromEntries(new URLSearchParams(String(opts.body))) }; return { status: 200, text: async () => JSON.stringify([{ service: 1, name: "Views", rate: "0.5" }]) }; };
  const out = await run({ baseUrl: "https://panel.example.com/api/v2", params: { key: "K", action: "services" } }, f, "1.1.1.1");
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, [{ service: 1, name: "Views", rate: "0.5" }]);
  assert.equal(seen.url, "https://panel.example.com/api/v2");
  assert.equal(seen.opts.method, "POST");
  assert.deepEqual(seen.form, { key: "K", action: "services" });
});

test("proxy: panel error JSON passes through unchanged (the website shows data.error)", async () => {
  const out = await run({ baseUrl: "https://panel.example.com/api", params: { key: "bad", action: "balance" } }, reply('{"error":"Invalid API key"}'), "1.1.1.2");
  assert.deepEqual(out.body, { error: "Invalid API key" });
});

test("proxy: rejects private addresses, bad params and non-JSON answers", async () => {
  const never = async () => { throw new Error("must not be called"); };
  assert.equal((await run({ baseUrl: "http://localhost:3000/x", params: { a: 1 } }, never, "1.1.1.3")).status, 400);
  assert.equal((await run({ baseUrl: "http://169.254.169.254/latest", params: { a: 1 } }, never, "1.1.1.3")).status, 400);
  assert.equal((await run({ baseUrl: "https://p.example.com", params: [] }, never, "1.1.1.3")).status, 400);
  assert.equal((await run({ baseUrl: "https://p.example.com" }, never, "1.1.1.3")).status, 400);
  assert.equal((await run({ baseUrl: "https://p.example.com", params: {} }, never, "1.1.1.3")).status, 400);
  const html = await run({ baseUrl: "https://p.example.com", params: { a: 1 } }, reply("<html>nope</html>"), "1.1.1.4");
  assert.equal(html.status, 502);
  assert.match(html.body.error, /not return JSON/);
});

test("proxy: redirects, timeouts and unreachable panels give clear errors", async () => {
  const red = await run({ baseUrl: "https://p.example.com", params: { a: 1 } }, reply("", 301), "1.1.1.5");
  assert.equal(red.status, 502);
  assert.match(red.body.error, /redirects/);
  const to = await run({ baseUrl: "https://p.example.com", params: { a: 1 } }, async () => { const e = new Error("x"); e.name = "AbortError"; throw e; }, "1.1.1.6");
  assert.equal(to.status, 504);
  const down = await run({ baseUrl: "https://p.example.com", params: { a: 1 } }, async () => { throw new Error("ENOTFOUND"); }, "1.1.1.7");
  assert.equal(down.status, 502);
});

test("proxy: one address cannot flood it (120 per minute)", async () => {
  const f = reply("{}");
  let last;
  for (let i = 0; i < 121; i++) last = await run({ baseUrl: "https://p.example.com", params: { a: 1 } }, f, "7.7.7.7");
  assert.equal(last.status, 429);
});
