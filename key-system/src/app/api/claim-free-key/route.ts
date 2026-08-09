import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { generateKeyValue, expiryFromMinutes } from "@/lib/keygen";
import { freeKeyLimiter, getClientIp } from "@/lib/ratelimit";

const FREE_KEY_DURATION_MINUTES = 48 * 60; // 48 hours
const LINKVERTISE_VERIFY_URL = "https://publisher.linkvertise.com/api/v1/anti_bypassing";

const bodySchema = z.object({
  hash: z.string().min(1).max(500),
});

async function verifyLinkvertiseHash(hash: string): Promise<boolean> {
  const token = process.env.LINKVERTISE_ANTI_BYPASS_TOKEN;
  if (!token) throw new Error("Missing LINKVERTISE_ANTI_BYPASS_TOKEN env variable.");

  const url = `${LINKVERTISE_VERIFY_URL}?token=${encodeURIComponent(
    token
  )}&hash=${encodeURIComponent(hash)}`;

  const res = await fetch(url, { method: "POST" });
  if (!res.ok) return false;

  // Linkvertise returns the literal string/boolean TRUE on success, and
  // deletes the hash so it can only ever be redeemed once (replay-proof).
  const text = (await res.text()).trim().toUpperCase();
  return text === "TRUE" || text === '"TRUE"';
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);

  // 1 free key per IP per day — stops farming free keys by spamming ads.
  const { success } = await freeKeyLimiter.limit(ip);
  if (!success) {
    return NextResponse.json(
      { error: "You've already claimed a free key today." },
      { status: 429 }
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  let verified: boolean;
  try {
    verified = await verifyLinkvertiseHash(parsed.data.hash);
  } catch {
    return NextResponse.json({ error: "Verification service error." }, { status: 502 });
  }

  if (!verified) {
    return NextResponse.json(
      { error: "Ad completion could not be verified. Please try again." },
      { status: 403 }
    );
  }

  const keyValue = generateKeyValue();
  const expiresAt = expiryFromMinutes(FREE_KEY_DURATION_MINUTES);

  const { data, error } = await supabaseAdmin
    .from("keys")
    .insert({
      key_value: keyValue,
      duration_minutes: FREE_KEY_DURATION_MINUTES,
      expires_at: expiresAt.toISOString(),
      source: "free_ad",
      status: "active",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Could not create key." }, { status: 500 });
  }

  return NextResponse.json({ key: data.key_value, expiresAt: data.expires_at });
}
