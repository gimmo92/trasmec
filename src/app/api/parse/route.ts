import { NextRequest, NextResponse } from "next/server";
import { parseBom } from "@/lib/excel";
import { resolveDocumento } from "@/lib/documenti";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

/** GET /api/parse?path=BE0806C-C010270.xlsm — parsa una distinta base. */
export async function GET(req: NextRequest) {
  const relPath = req.nextUrl.searchParams.get("path");
  if (!relPath) {
    return NextResponse.json({ error: "Parametro 'path' mancante" }, { status: 400 });
  }
  try {
    await prepareApp();
    const full = resolveDocumento(relPath);
    const parsed = parseBom(full, relPath);
    return NextResponse.json(parsed);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di parsing" },
      { status: 500 }
    );
  }
}
