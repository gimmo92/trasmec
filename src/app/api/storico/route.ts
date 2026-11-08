import { NextRequest, NextResponse } from "next/server";
import { prepareApp } from "@/lib/prepare";
import { listStorico, saveStorico, storicoVoce } from "@/lib/storico";
import type { Offer } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prepareApp();
    const items = await listStorico();
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const offer = body?.offer as Offer | undefined;
    if (!offer) {
      return NextResponse.json({ error: "Offerta mancante" }, { status: 400 });
    }
    await prepareApp();
    const item = await saveStorico(offer);
    return NextResponse.json({ item: storicoVoce(item) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di salvataggio" },
      { status: 500 }
    );
  }
}
