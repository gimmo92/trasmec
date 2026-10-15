import { NextRequest, NextResponse } from "next/server";
import { buildSparePartsOffer } from "@/lib/offer";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/generate
 * body: { paths?: string[] }  (opzionale: limita alle distinte selezionate)
 * Legge il documento d'ordine, individua gli item dopo AFTER SALES, estrae i
 * ricambi delle relative distinte e aggiunge motori/sensori.
 */
export async function POST(req: NextRequest) {
  try {
    let paths: string[] = [];
    try {
      const body = await req.json();
      if (Array.isArray(body?.paths)) paths = body.paths;
    } catch {
      /* body opzionale */
    }

    const offer = await buildSparePartsOffer({ restrictPaths: paths });
    return NextResponse.json({ offer });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di generazione" },
      { status: 500 }
    );
  }
}
