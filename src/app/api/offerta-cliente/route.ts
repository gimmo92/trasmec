import { NextRequest, NextResponse } from "next/server";
import { buildOffertaCliente } from "@/lib/offertacliente";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const email = form.get("email");
    let emailRaw = "";
    if (email instanceof File) {
      emailRaw = await email.text();
    }
    const commessa = String(form.get("commessa") ?? "");
    let righe: { componente?: string; quantita?: string }[] = [];
    try {
      const parsed = JSON.parse(String(form.get("righe") ?? "[]"));
      if (Array.isArray(parsed)) righe = parsed;
    } catch {
      righe = [];
    }

    const offer = await buildOffertaCliente({ emailRaw, commessa, righe });
    return NextResponse.json({ offer });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di generazione" },
      { status: 500 }
    );
  }
}
