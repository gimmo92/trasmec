import { NextRequest, NextResponse } from "next/server";
import { generaOrdine, getOrdine, listOrdini } from "@/lib/ordini";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    await prepareApp();
    const ordini = await listOrdini();
    return NextResponse.json({ ordini });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await prepareApp();
    const body = await req.json().catch(() => ({}));
    if (body.id) {
      const ordine = await getOrdine(String(body.id));
      if (!ordine) {
        return NextResponse.json({ error: "Ordine non trovato" }, { status: 404 });
      }
      return NextResponse.json({ ordine });
    }
    const ordine = await generaOrdine(String(body.sourceFile ?? ""));
    return NextResponse.json({ ordine }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 400 }
    );
  }
}
