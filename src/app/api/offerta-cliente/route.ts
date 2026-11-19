import { NextRequest, NextResponse } from "next/server";
import { buildOffertaCliente, textFromMailParts, textFromMsg } from "@/lib/offertacliente";
import { prepareApp } from "@/lib/prepare";
import type { SorgenteCaricato } from "@/lib/sorgente";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    // Listino YPRI e Spare Parts List: online vanno scaricati dallo storage prima dell'uso.
    await prepareApp();
    const form = await req.formData();
    const email = form.get("email");
    let emailRaw = "";
    let mailLetta: { subject: string; text: string } | undefined;
    const emailSubject = form.get("emailSubject");
    const emailBody = form.get("emailBody");
    if (typeof emailSubject === "string" || typeof emailBody === "string") {
      // .msg letto nel browser: arrivano solo oggetto e testo, senza allegati.
      mailLetta = textFromMailParts(String(emailSubject ?? ""), String(emailBody ?? ""));
    } else if (email instanceof File) {
      if (email.name.toLowerCase().endsWith(".msg")) {
        mailLetta = textFromMsg(await email.arrayBuffer());
      } else {
        emailRaw = await email.text();
      }
    }
    const commessa = String(form.get("commessa") ?? "");
    let righe: { componente?: string; quantita?: string }[] = [];
    try {
      const parsed = JSON.parse(String(form.get("righe") ?? "[]"));
      if (Array.isArray(parsed)) righe = parsed;
    } catch {
      righe = [];
    }

    // File sorgente scelti dall'utente: le distinte Excel arrivano intere, gli altri solo col nome.
    const sorgenti: SorgenteCaricato[] = [];
    for (const item of form.getAll("sorgente")) {
      if (item instanceof File) {
        sorgenti.push({ name: item.name, data: Buffer.from(await item.arrayBuffer()) });
      }
    }
    for (const item of form.getAll("sorgenteNome")) {
      if (typeof item === "string" && item.trim()) sorgenti.push({ name: item.trim() });
    }

    const offer = await buildOffertaCliente({
      emailRaw,
      email: mailLetta,
      commessa,
      righe,
      sorgenti,
      codiceCliente: String(form.get("codiceCliente") ?? ""),
      redattore: String(form.get("redattore") ?? ""),
    });
    return NextResponse.json({ offer });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di generazione" },
      { status: 500 }
    );
  }
}
