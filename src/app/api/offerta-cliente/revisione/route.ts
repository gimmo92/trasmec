import { NextRequest, NextResponse } from "next/server";
import { reviseOffertaCliente, type OffertaCliente } from "@/lib/offertacliente";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const istruzione = String(body?.istruzione ?? "").trim();
    if (!istruzione) {
      return NextResponse.json({ error: "Scrivi la modifica da applicare" }, { status: 400 });
    }
    const offer = body?.offer as OffertaCliente | undefined;
    if (!offer || !Array.isArray(offer.righe)) {
      return NextResponse.json({ error: "Offerta mancante" }, { status: 400 });
    }
    const revised = await reviseOffertaCliente(offer, istruzione);
    return NextResponse.json({ offer: revised });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di modifica" },
      { status: 500 }
    );
  }
}
