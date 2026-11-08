import { NextRequest, NextResponse } from "next/server";
import { prepareApp } from "@/lib/prepare";
import { deleteStorico, getStorico, saveStorico, storicoVoce } from "@/lib/storico";
import type { Offer } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prepareApp();
    const item = await getStorico(id);
    if (!item) {
      return NextResponse.json({ error: "Offerta non trovata nello storico" }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const offer = body?.offer as Offer | undefined;
    if (!offer) {
      return NextResponse.json({ error: "Offerta mancante" }, { status: 400 });
    }
    await prepareApp();
    const item = await saveStorico(offer, id);
    return NextResponse.json({ item: storicoVoce(item) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Errore di salvataggio";
    const status = /non trovata/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prepareApp();
    const ok = await deleteStorico(id);
    if (!ok) {
      return NextResponse.json({ error: "Offerta non trovata nello storico" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
