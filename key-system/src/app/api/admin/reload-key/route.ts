import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { generateKeyValue } from "@/lib/keygen";
import { isAdminRequest } from "@/lib/requireAdmin";
import { generalLimiter, getClientIp } from "@/lib/ratelimit";

const bodySchema = z.object({
  id: z.string().uuid(),
});

// "Reload" = only the key word changes. Same expiry / duration stays as-is.
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const ip = getClientIp(req.headers);
  const { success } = await generalLimiter.limit(ip);
  if (!success) {
    return NextResponse.json({ error: "Rate limited." }, { status: 429 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const newKeyValue = generateKeyValue();

  const { data, error } = await supabaseAdmin
    .from("keys")
    .update({
      key_value: newKeyValue,
      last_reloaded_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.id)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Could not reload key." }, { status: 404 });
  }

  return NextResponse.json({ key: data });
}
