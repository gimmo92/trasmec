import { NextRequest, NextResponse } from "next/server";
import { buildSparePartsOffer } from "@/lib/offer";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/generate
 * body: { orderPath: string, paths?: string[] }
 * Legge il documento d'ordine, individua gli item dopo AFTER SALES, estrae i
 * ricambi delle relative distinte e aggiunge motori/sensori.
 */
export async function POST(req: NextRequest) {
  try {
    let paths: string[] = [];
    let orderPath = "";
    try {
      const body = await req.json();
      if (Array.isArray(body?.paths)) paths = body.paths;
      if (typeof body?.orderPath === "string") orderPath = body.orderPath;
    } catch {
      /* body letto sotto */
    }

    const offer = await buildSparePartsOffer({ orderPath, restrictPaths: paths });
    return NextResponse.json({ offer });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore di generazione" },
      { status: 500 }
    );
  }
}
