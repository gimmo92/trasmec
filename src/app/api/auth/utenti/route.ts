import { NextRequest, NextResponse } from "next/server";
import { currentEmail } from "@/lib/sessioncookie";
import { createUser, deleteUser, listPublicUsers, validateNewAccount } from "@/lib/users";

export const runtime = "nodejs";

async function requireEmail() {
  const email = await currentEmail();
  if (!email) return null;
  return email;
}

export async function GET() {
  const email = await requireEmail();
  if (!email) return NextResponse.json({ error: "Accesso richiesto" }, { status: 401 });
  const users = await listPublicUsers();
  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  try {
    const actor = await requireEmail();
    if (!actor) return NextResponse.json({ error: "Accesso richiesto" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const password = String(body.password ?? "");
    const email = validateNewAccount(String(body.email ?? ""), password);
    await createUser(email, password);
    return NextResponse.json({ email }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actor = await requireEmail();
    if (!actor) return NextResponse.json({ error: "Accesso richiesto" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "");
    if (email.trim().toLowerCase() === actor) {
      return NextResponse.json(
        { error: "Non puoi eliminare l'account con cui sei entrato" },
        { status: 400 }
      );
    }
    await deleteUser(email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 400 }
    );
  }
}
