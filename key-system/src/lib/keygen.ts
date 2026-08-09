import { randomBytes } from "crypto";

// Cryptographically secure random key, formatted in readable groups
// e.g. KM-9F2A-7D1C-BE44-01AA
export function generateKeyValue(): string {
  const bytes = randomBytes(16).toString("hex").toUpperCase(); // 32 hex chars
  const groups = bytes.match(/.{1,4}/g) ?? [];
  return `KM-${groups.join("-")}`;
}

export function expiryFromMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}
