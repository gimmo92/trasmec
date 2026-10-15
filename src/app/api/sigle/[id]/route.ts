import { NextRequest, NextResponse } from "next/server";
import { deleteSigla, updateSigla } from "@/lib/sigle";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    await prepareApp();
    const item = await updateSigla(id, body ?? {});
    if (!item) {
      return NextResponse.json({ error: "Riga non trovata" }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prepareApp();
    const ok = await deleteSigla(id);
    if (!ok) {
      return NextResponse.json({ error: "Riga non trovata" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
