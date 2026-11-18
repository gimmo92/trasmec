import { NextRequest, NextResponse } from "next/server";
import { getIstruzioni, hydrateIstruzioni, setIstruzioni } from "@/lib/istruzioni";
import { useCloud } from "@/lib/cloud";

export const runtime = "nodejs";

/** Solo le istruzioni: non aspetta la sync dei documenti. */
async function ready(): Promise<void> {
  if (useCloud()) await hydrateIstruzioni();
}

export async function GET() {
  try {
    await ready();
    return NextResponse.json({ text: getIstruzioni() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const text = await setIstruzioni(typeof body?.text === "string" ? body.text : "");
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
