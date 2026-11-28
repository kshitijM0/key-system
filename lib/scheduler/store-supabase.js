"use strict";

// Database layer for the scheduler. Uses the same server-side Supabase client as the rest of the project
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY). Tables come from supabase/scheduler-schema.sql.

const { getSupabaseAdmin } = require("../supabase");

function fail(error, what) {
  const e = new Error(`Scheduler database error while ${what}: ${error.message || error.code || "unknown"}`);
  e.dbCode = error.code;
  return e;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function createSupabaseStore(db = getSupabaseAdmin()) {
  return {
    // All-or-nothing: if the legs cannot be saved, the order row is removed again.
    async insertOrder(order, legs) {
      const first = await db.from("sched_orders").insert(order);
      if (first.error) throw fail(first.error, "saving the order (did you run supabase/scheduler-schema.sql?)");
      for (const part of chunks(legs, 500)) {
        const r = await db.from("sched_legs").insert(part);
        if (r.error) {
          await db.from("sched_orders").delete().eq("id", order.id); // legs cascade
          throw fail(r.error, "saving the order parts");
        }
      }
    },

    // Looks at pending parts whose time has come (no changes). `after` is exclusive, `upTo` inclusive.
    async peekDue({ after, upTo, limit }) {
      let q = db.from("sched_legs").select("*").eq("status", "pending").lte("fire_at", upTo).order("fire_at", { ascending: true }).limit(limit);
      if (after) q = q.gt("fire_at", after);
      const r = await q;
      if (r.error) throw fail(r.error, "looking for due parts");
      return r.data || [];
    },

    // Marks the chosen parts "processing". The update only touches rows that are still "pending",
    // so two servers can never send the same part twice. Returns only the rows really claimed.
    async claimLegs(ids, nowIso) {
      const r = await db.from("sched_legs").update({ status: "processing", claimed_at: nowIso }).in("id", ids).eq("status", "pending").select("*");
      if (r.error) throw fail(r.error, "claiming due parts");
      return r.data || [];
    },

    async failStuck(cutoffIso, message) {
      const r = await db.from("sched_legs").update({ status: "failed", last_error: message }).eq("status", "processing").lt("claimed_at", cutoffIso).select("order_id");
      if (r.error) throw fail(r.error, "recovering stuck parts");
      return [...new Set((r.data || []).map((x) => x.order_id))];
    },

    async updateLeg(id, patch) {
      const r = await db.from("sched_legs").update(patch).eq("id", id);
      if (r.error) throw fail(r.error, "updating a part");
    },

    async countLegs(orderId, status) {
      const r = await db.from("sched_legs").select("id", { count: "exact", head: true }).eq("order_id", orderId).eq("status", status);
      if (r.error) throw fail(r.error, "counting parts");
      return r.count || 0;
    },

    async getOrder(id) {
      const r = await db.from("sched_orders").select("*").eq("id", id).maybeSingle();
      if (r.error) throw fail(r.error, "reading an order");
      return r.data || null;
    },

    async updateOrder(id, patch) {
      const r = await db.from("sched_orders").update(patch).eq("id", id);
      if (r.error) throw fail(r.error, "updating an order");
    },

    async setLegsStatus(orderId, from, to) {
      const r = await db.from("sched_legs").update({ status: to }).eq("order_id", orderId).eq("status", from);
      if (r.error) throw fail(r.error, "changing order parts");
    },

    async deleteOrder(id) {
      const r = await db.from("sched_orders").delete().eq("id", id); // legs cascade
      if (r.error) throw fail(r.error, "deleting an order");
    },

    async listOrders(limit, sinceIso) {
      const r = await db.from("sched_orders").select("*").gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(limit);
      if (r.error) throw fail(r.error, "listing orders");
      return r.data || [];
    },

    async nextFireAt(orderId, status) {
      const r = await db.from("sched_legs").select("fire_at").eq("order_id", orderId).eq("status", status).order("fire_at", { ascending: true }).limit(1);
      if (r.error) throw fail(r.error, "reading the next delivery time");
      return r.data && r.data[0] ? r.data[0].fire_at : null;
    },

    async recentDone(sinceIso, limit, link) {
      let q = db.from("sched_legs").select("category, quantity, done_at, link").eq("status", "done").gte("done_at", sinceIso).order("done_at", { ascending: false }).limit(limit);
      if (link) q = q.eq("link", link);
      const r = await q;
      if (r.error) throw fail(r.error, "reading delivery history");
      return r.data || [];
    },

    async recentOrders(limit) {
      const r = await db.from("sched_orders").select("base_url, key_hint, total_quantity, total_legs, link, created_at").order("created_at", { ascending: false }).limit(limit);
      if (r.error) throw fail(r.error, "reading the activity log");
      return r.data || [];
    },
  };
}

module.exports = { createSupabaseStore };
