import { NextResponse } from "next/server";
import { listDocumenti } from "@/lib/documenti";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prepareApp();
    const files = listDocumenti();
    return NextResponse.json({ files });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
