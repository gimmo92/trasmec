import { NextRequest, NextResponse } from "next/server";
import { getIstruzioni, setIstruzioni } from "@/lib/istruzioni";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prepareApp();
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
    await prepareApp();
    const text = await setIstruzioni(typeof body?.text === "string" ? body.text : "");
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
