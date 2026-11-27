"use strict";

// HTTP routes of the scheduler. They answer exactly like the old kmpanel.onrender.com service,
// so script.js keeps working: POST /schedule-order, GET /orders, DELETE /orders/:id,
// POST /orders/:id/(pause|resume), GET /history, GET /delivered-log, GET /activity-log.
// Extra: GET|POST /tick (sends everything that is due; safe to call as often as you like).

const core = require("./core");
const runtime = require("./runtime");

const TICK_INTERVAL_MS = 20 * 1000;

function allowedOrigins() {
  const fromEnv = (process.env.SCHEDULER_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  // Defaults: the Render site, the Vercel site and the temporary GitHub Pages site. Add more in SCHEDULER_ALLOWED_ORIGINS.
  return new Set(["https://thekm.onrender.com", "https://kshitijm0.github.io", "https://kmpremium.vercel.app", ...fromEnv]);
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
}

// Small per-IP limit on the public "create schedule" endpoint (20 per 10 minutes).
const hits = new Map();
function rateLimited(req) {
  // Server-to-server calls (Auto orders coming from the Vercel site) carry a shared secret and skip the limit.
  const shared = process.env.SCHEDULER_SHARED_SECRET;
  const given = String(req.headers["x-scheduler-secret"] || "");
  if (shared && given.length === shared.length && require("crypto").timingSafeEqual(Buffer.from(given), Buffer.from(shared))) return false;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 20;
}

function wrap(label, fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.clientError) return res.status(err.status || 400).json({ error: err.message });
      console.error(`[scheduler:${label}]`, err);
      if (!res.headersSent) res.status(500).json({ error: "Scheduler error. Check the server logs." });
    }
  };
}

let tickRunning = false;
async function safeTick() {
  if (tickRunning) return { skipped: true };
  tickRunning = true;
  try {
    return await runtime.runTick();
  } finally {
    tickRunning = false;
  }
}

function mount(app) {
  // app.use("/orders") also covers /orders/:id and /orders/:id/:action
  ["/schedule-order", "/orders", "/history", "/delivered-log", "/activity-log", "/tick"].forEach((p) => app.use(p, cors));

  app.post("/schedule-order", wrap("schedule-order", async (req, res) => {
    if (rateLimited(req)) return res.status(429).json({ error: "Too many schedules from this connection. Try again in a few minutes." });
    const result = await runtime.scheduleLocal(req.body);
    setImmediate(() => safeTick().catch((e) => console.error("[scheduler:tick]", e))); // legs due right now go out immediately
    res.status(200).json({ scheduled: result.scheduled });
  }));

  app.get("/orders", wrap("orders", async (req, res) => {
    res.status(200).json(await core.listOrders(runtime.getStore()));
  }));

  app.delete("/orders/:id", wrap("delete-order", async (req, res) => {
    res.status(200).json(await core.deleteOrder(runtime.getStore(), req.params.id));
  }));

  app.post("/orders/:id/:action", wrap("order-action", async (req, res) => {
    res.status(200).json(await core.setOrderAction(runtime.getStore(), req.params.id, req.params.action));
  }));

  app.get("/history", wrap("history", async (req, res) => {
    res.status(200).json(await core.history(runtime.getStore(), req.query.link));
  }));

  app.get("/delivered-log", wrap("delivered-log", async (req, res) => {
    res.status(200).json(await core.deliveredLog(runtime.getStore()));
  }));

  app.get("/activity-log", wrap("activity-log", async (req, res) => {
    res.status(200).json(await core.activityLog(runtime.getStore()));
  }));

  app.all("/tick", wrap("tick", async (req, res) => {
    const secret = process.env.SCHEDULER_TICK_SECRET;
    if (secret && req.query.secret !== secret) return res.status(403).json({ error: "Forbidden." });
    res.status(200).json(await safeTick());
  }));
}

// Checks for due parts every 20 seconds while the server is awake, and once shortly after start-up
// (to catch up on anything that became due while the server was asleep).
function startTicker() {
  const run = () => safeTick().then((r) => { if (r && r.claimed) console.log("[scheduler] tick", JSON.stringify(r)); }).catch((e) => console.error("[scheduler:tick]", e.message));
  setTimeout(run, 5000);
  return setInterval(run, TICK_INTERVAL_MS);
}

module.exports = { mount, startTicker, cors };
