import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { validateKeyLimiter, getClientIp } from "@/lib/ratelimit";

const bodySchema = z.object({
  key: z.string().min(5).max(100),
});

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);

  // Brute-force protection: 5 guesses per minute per IP.
  const { success } = await validateKeyLimiter.limit(ip);
  if (!success) {
    return NextResponse.json(
      { valid: false, error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ valid: false, error: "Invalid request." }, { status: 400 });
  }

  const { data } = await supabaseAdmin
    .from("keys")
    .select("status, expires_at")
    .eq("key_value", parsed.data.key)
    .maybeSingle();

  // Server-side expiry validation — never trust a client-stored expiry.
  const isValid =
    !!data && data.status === "active" && new Date(data.expires_at) > new Date();

  return NextResponse.json({ valid: isValid });
}
