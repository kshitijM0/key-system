import { createHmac, timingSafeEqual } from "crypto";

// SERVER-ONLY FILE.
const SESSION_COOKIE = "admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function getSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("Missing ADMIN_SESSION_SECRET env variable.");
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

// Builds a signed, tamper-proof session value: "<expiryTimestamp>.<hmacSignature>"
export function createSessionValue(): string {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = String(expiry);
  return `${payload}.${sign(payload)}`;
}

export function isSessionValid(value: string | undefined): boolean {
  if (!value) return false;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return false;

  const expected = sign(payload);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  if (!timingSafeEqual(sigBuf, expBuf)) return false;

  const expiry = Number(payload);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

export function verifyAdminPassword(candidate: string): boolean {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) throw new Error("Missing ADMIN_PASSWORD env variable.");

  const candidateBuf = Buffer.from(candidate);
  const realBuf = Buffer.from(real);
  if (candidateBuf.length !== realBuf.length) return false;
  return timingSafeEqual(candidateBuf, realBuf);
}

export const ADMIN_COOKIE_NAME = SESSION_COOKIE;
export const ADMIN_COOKIE_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;
