"use strict";

// POST /proxy  { baseUrl, params }  ->  forwards the call to an SMM panel and returns the panel's JSON.
// Same contract as the separate Vercel proxy (kmpanel-proxy.vercel.app), now built into the Node server,
// so the proxy and the scheduler can live in ONE Render service.
//
// The browser cannot call a panel directly (CORS), so it asks this route to do it.

const { isPublicHttpUrl } = require("./scheduler/core");

const TIMEOUT_MS = 25 * 1000;
const MAX_RESPONSE_CHARS = 25 * 1024 * 1024;
const MAX_PARAMS = 40;
const PER_MINUTE_LIMIT = 120;

const hits = new Map();
function tooMany(req) {
  const ip = String(req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "?").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60 * 1000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > PER_MINUTE_LIMIT;
}

async function proxyHandler(req, res, fetchImpl = fetch) {
  if (tooMany(req)) return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });

  const { baseUrl, params } = req.body || {};
  if (!isPublicHttpUrl(baseUrl)) {
    return res.status(400).json({ error: "The panel API URL must be a public http(s) address." });
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return res.status(400).json({ error: "params must be an object." });
  }
  const entries = Object.entries(params);
  if (entries.length === 0 || entries.length > MAX_PARAMS) {
    return res.status(400).json({ error: "Invalid params." });
  }

  const form = new URLSearchParams();
  for (const [k, v] of entries) {
    if (String(k).length > 60) return res.status(400).json({ error: "Invalid params." });
    form.set(k, v === undefined || v === null ? "" : String(v).slice(0, 100000));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetchImpl(String(baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal,
      redirect: "manual", // never follow redirects (also protects against redirects to internal addresses)
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return res.status(502).json({ error: "The panel API URL redirects somewhere else. Use the final https:// API URL of the panel." });
    }

    const text = await upstream.text();
    if (text.length > MAX_RESPONSE_CHARS) return res.status(502).json({ error: "The panel answer is too large." });

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: `The panel did not return JSON (HTTP ${upstream.status}). Check the API URL.` });
    }
    return res.status(200).json(data);
  } catch (err) {
    if (err && err.name === "AbortError") return res.status(504).json({ error: "The panel did not answer in time." });
    return res.status(502).json({ error: "Could not reach the panel." });
  } finally {
    clearTimeout(timer);
  }
}

function mount(app, cors) {
  app.use("/proxy", cors);
  app.post("/proxy", (req, res) => {
    proxyHandler(req, res).catch((error) => {
      console.error("[proxy]", error);
      if (!res.headersSent) res.status(500).json({ error: "Proxy error." });
    });
  });
}

module.exports = { mount, proxyHandler };
