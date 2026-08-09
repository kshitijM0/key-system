import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { isAdminRequest } from "@/lib/requireAdmin";

const bodySchema = z.object({ id: z.string().uuid() });

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("keys")
    .update({ status: "revoked" })
    .eq("id", parsed.data.id);

  if (error) {
    return NextResponse.json({ error: "Could not revoke key." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
