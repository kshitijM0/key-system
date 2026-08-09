import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { adminLoginLimiter, getClientIp } from "@/lib/ratelimit";
import {
  createSessionValue,
  verifyAdminPassword,
  ADMIN_COOKIE_NAME,
  ADMIN_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/adminSession";

const bodySchema = z.object({
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  const ip = getClientIp(req.headers);

  // Brute-force protection: 5 attempts per 10 minutes per IP.
  const { success } = await adminLoginLimiter.limit(ip);
  if (!success) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429 }
    );
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!verifyAdminPassword(parsed.data.password)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE_NAME, createSessionValue(), {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: ADMIN_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
