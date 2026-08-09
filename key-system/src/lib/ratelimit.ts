import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// SERVER-ONLY FILE.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// General API abuse protection: 10 requests per minute per IP.
export const generalLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"),
  prefix: "ratelimit:general",
});

// Stricter limiter for key validation — brute-force protection.
// 5 attempts per minute per IP, blocks guessing key strings.
export const validateKeyLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"),
  prefix: "ratelimit:validate",
});

// Admin login attempts — very strict, brute-force protection on the password.
export const adminLoginLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "10 m"),
  prefix: "ratelimit:admin_login",
});

// Free key claims — 1 per IP per day, stops farming free keys.
export const freeKeyLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(1, "1440 m"),
  prefix: "ratelimit:free_key",
});

export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}
