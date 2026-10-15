import { NextRequest, NextResponse } from "next/server";
import { associaDistinta, readArchivio } from "@/lib/archivio";
import { useCloud } from "@/lib/cloud";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prepareApp();
    const archivio = await readArchivio();
    return NextResponse.json({ ...archivio, supabase: useCloud() });
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
    const distinta = await associaDistinta(
      String(body.distinta ?? ""),
      Array.isArray(body.ordini) ? body.ordini.map(String) : []
    );
    return NextResponse.json({ distinta });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 400 }
    );
  }
}
