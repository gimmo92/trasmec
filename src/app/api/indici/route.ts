import { NextRequest, NextResponse } from "next/server";
import { createIndice, listIndici } from "@/lib/indici";
import { prepareApp } from "@/lib/prepare";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prepareApp();
    return NextResponse.json({ items: listIndici() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    await prepareApp();
    const item = await createIndice(body ?? {});
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Errore" },
      { status: 500 }
    );
  }
}
