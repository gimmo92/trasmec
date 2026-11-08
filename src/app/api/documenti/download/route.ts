import { NextRequest, NextResponse } from "next/server";
import { documentoContentType, readDocumento, safeDocumentoName } from "@/lib/documenti";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

function attachmentName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Scarica un file caricato in archivio. */
export async function GET(req: NextRequest) {
  try {
    await prepareApp();
    const name = safeDocumentoName(req.nextUrl.searchParams.get("name") ?? "");
    const data = await readDocumento(name);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": documentoContentType(name),
        "Content-Disposition": attachmentName(name),
        "Content-Length": String(data.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Errore";
    const status = /non trovato/i.test(message) ? 404 : /non valido|Carica un/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
