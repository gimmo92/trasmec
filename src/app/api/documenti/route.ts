import { NextRequest, NextResponse } from "next/server";
import { downloadFile, signedUploadUrl, useCloud } from "@/lib/cloud";
import { listDocumentiClassificati, safeDocumentoName, saveDocumento } from "@/lib/documenti";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prepareApp();
    const files = await listDocumentiClassificati();
    return NextResponse.json({ files, supabase: useCloud() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}

/** Carica un file, oppure prepara un URL firmato per i file più grandi del limite di Vercel. */
export async function POST(req: NextRequest) {
  try {
    await prepareApp();
    const type = req.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const body = await req.json().catch(() => ({}));
      if (body.action === "firma") {
        if (!useCloud()) {
          return NextResponse.json(
            { error: "File troppo grande per il caricamento diretto" },
            { status: 400 }
          );
        }
        const name = safeDocumentoName(String(body.name ?? ""));
        const signedUrl = await signedUploadUrl(`documenti/${name}`);
        return NextResponse.json({ name, signedUrl });
      }
      if (body.action === "completa") {
        const name = safeDocumentoName(String(body.name ?? ""));
        const buf = await downloadFile(`documenti/${name}`);
        if (!buf) {
          return NextResponse.json({ error: "File non arrivato nello storage" }, { status: 400 });
        }
        const file = await saveDocumento(name, buf, { alreadyInCloud: true });
        return NextResponse.json({ file });
      }
      return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    }

    const form = await req.formData();
    const incoming = form.get("file");
    if (!(incoming instanceof File)) {
      return NextResponse.json({ error: "Nessun file" }, { status: 400 });
    }
    const data = Buffer.from(await incoming.arrayBuffer());
    const file = await saveDocumento(incoming.name, data);
    return NextResponse.json({ file });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di caricamento" },
      { status: 400 }
    );
  }
}
