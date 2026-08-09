import { createClient } from "@supabase/supabase-js";

// SERVER-ONLY FILE. Never import this from a "use client" component.
// SUPABASE_SERVICE_ROLE_KEY has full database access and bypasses Row Level
// Security — it must only ever exist as a server-side environment variable,
// never prefixed with NEXT_PUBLIC_, never sent to the browser.

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
  );
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
