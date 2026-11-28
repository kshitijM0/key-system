"use strict";
// In-memory version of the scheduler store, used only by the tests.

function createMemoryStore() {
  const orders = new Map();
  const legs = new Map();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  return {
    _orders: orders,
    _legs: legs,
    async insertOrder(order, legRows) {
      orders.set(order.id, { created_at: new Date().toISOString(), ...clone(order) });
      legRows.forEach((l) => legs.set(l.id, { claimed_at: null, done_at: null, provider_order_id: null, last_error: null, ...clone(l) }));
    },
    async peekDue({ after, upTo, limit }) {
      return clone([...legs.values()].filter((l) => l.status === "pending" && l.fire_at <= upTo && (!after || l.fire_at > after)).sort((a, b) => (a.fire_at < b.fire_at ? -1 : 1)).slice(0, limit));
    },
    async claimLegs(ids, nowIso) {
      const rows = ids.map((id) => legs.get(id)).filter((l) => l && l.status === "pending");
      rows.forEach((l) => { l.status = "processing"; l.claimed_at = nowIso; });
      return clone(rows);
    },
    async failStuck(cutoffIso, message) {
      const stuck = [...legs.values()].filter((l) => l.status === "processing" && l.claimed_at < cutoffIso);
      stuck.forEach((l) => { l.status = "failed"; l.last_error = message; });
      return [...new Set(stuck.map((l) => l.order_id))];
    },
    async updateLeg(id, patch) { Object.assign(legs.get(id), patch); },
    async countLegs(orderId, status) { return [...legs.values()].filter((l) => l.order_id === orderId && l.status === status).length; },
    async getOrder(id) { return orders.has(id) ? clone(orders.get(id)) : null; },
    async updateOrder(id, patch) { Object.assign(orders.get(id), patch); },
    async setLegsStatus(orderId, from, to) { [...legs.values()].filter((l) => l.order_id === orderId && l.status === from).forEach((l) => { l.status = to; }); },
    async deleteOrder(id) { orders.delete(id); [...legs.values()].filter((l) => l.order_id === id).forEach((l) => legs.delete(l.id)); },
    async listOrders(limit, sinceIso) { return clone([...orders.values()].filter((o) => o.created_at >= sinceIso).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit)); },
    async nextFireAt(orderId, status) {
      const t = [...legs.values()].filter((l) => l.order_id === orderId && l.status === status).map((l) => l.fire_at).sort();
      return t[0] || null;
    },
    async recentDone(sinceIso, limit, link) {
      return clone([...legs.values()].filter((l) => l.status === "done" && l.done_at >= sinceIso && (!link || l.link === link)).sort((a, b) => (a.done_at < b.done_at ? 1 : -1)).slice(0, limit)
        .map((l) => ({ category: l.category, quantity: l.quantity, done_at: l.done_at, link: l.link })));
    },
    async recentOrders(limit) { return clone([...orders.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, limit)); },
  };
}
module.exports = { createMemoryStore };
