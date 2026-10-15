import { NextRequest, NextResponse } from "next/server";
import { startSession } from "@/lib/sessioncookie";
import { authenticate } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const user = await authenticate(String(body.email ?? ""), String(body.password ?? ""));
    if (!user) {
      return NextResponse.json({ error: "Email o password non corretti" }, { status: 401 });
    }
    await startSession(user.email);
    return NextResponse.json({ email: user.email });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di accesso" },
      { status: 500 }
    );
  }
}
