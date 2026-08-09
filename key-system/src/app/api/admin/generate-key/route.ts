import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { generateKeyValue, expiryFromMinutes } from "@/lib/keygen";
import { isAdminRequest } from "@/lib/requireAdmin";
import { generalLimiter, getClientIp } from "@/lib/ratelimit";

const bodySchema = z.object({
  // e.g. 60 = 1 hour, 1440 = 24 hours, 2880 = 48 hours
  durationMinutes: z.number().int().positive().max(60 * 24 * 365),
});

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

  const { durationMinutes } = parsed.data;
  const keyValue = generateKeyValue();
  const expiresAt = expiryFromMinutes(durationMinutes);

  const { data, error } = await supabaseAdmin
    .from("keys")
    .insert({
      key_value: keyValue,
      duration_minutes: durationMinutes,
      expires_at: expiresAt.toISOString(),
      source: "admin",
      status: "active",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Could not create key." }, { status: 500 });
  }

  return NextResponse.json({ key: data });
}
