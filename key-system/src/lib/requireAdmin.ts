import { NextRequest } from "next/server";
import { isSessionValid, ADMIN_COOKIE_NAME } from "@/lib/adminSession";

export function isAdminRequest(req: NextRequest): boolean {
  const cookie = req.cookies.get(ADMIN_COOKIE_NAME)?.value;
  return isSessionValid(cookie);
}
