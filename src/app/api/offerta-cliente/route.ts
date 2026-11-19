import { NextRequest, NextResponse } from "next/server";
import { buildOffertaCliente, textFromMailParts, textFromMsg } from "@/lib/offertacliente";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
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

    const offer = await buildOffertaCliente({ emailRaw, email: mailLetta, commessa, righe });
    return NextResponse.json({ offer });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di generazione" },
      { status: 500 }
    );
  }
}
