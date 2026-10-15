import { NextRequest, NextResponse } from "next/server";
import { startSession } from "@/lib/sessioncookie";
import { createUser, hasUsers, validateNewAccount } from "@/lib/users";

export const runtime = "nodejs";

/** Crea il primo account e apre la sessione. Dopo il primo utente risponde 403. */
export async function POST(req: NextRequest) {
  try {
    if (await hasUsers()) {
      return NextResponse.json({ error: "L'account iniziale esiste già" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const email = validateNewAccount(String(body.email ?? ""), String(body.password ?? ""));
    await createUser(email, String(body.password ?? ""));
    await startSession(email);
    return NextResponse.json({ email }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 400 }
    );
  }
}
