import { NextResponse } from "next/server";
import { currentEmail } from "@/lib/sessioncookie";
import { hasUsers } from "@/lib/users";

export const runtime = "nodejs";

export async function GET() {
  try {
    const email = await currentEmail();
    const needsSetup = !(await hasUsers());
    return NextResponse.json({ email, needsSetup });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
