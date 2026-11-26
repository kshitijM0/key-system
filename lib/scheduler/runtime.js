"use strict";

// Wires the scheduler core to the real database and the real encryption key.
// Used by the Express routes (routes.js) and by the Auto-Key order flow (lib/auto/keyOrder.js).

const core = require("./core");
const { createSupabaseStore } = require("./store-supabase");
const { encryptSecret, decryptSecret } = require("../crypto");

let store = null;
function getStore() {
  if (!store) store = createSupabaseStore();
  return store;
}

// Schedules an order directly (no HTTP hop). Same body as POST /schedule-order.
function scheduleLocal(body) {
  return core.scheduleOrder({ store: getStore(), encrypt: encryptSecret, body });
}

function runTick(options = {}) {
  return core.tick({ store: getStore(), decrypt: decryptSecret, ...options });
}

module.exports = { getStore, scheduleLocal, runTick };
