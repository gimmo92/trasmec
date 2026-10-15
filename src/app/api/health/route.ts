import { NextResponse } from "next/server";
import { isApiKeyConfigured, DEFAULT_MODEL } from "@/lib/anthropic";
import { useCloud } from "@/lib/cloud";
import { getDocumentiDir } from "@/lib/documenti";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    apiKeyConfigured: isApiKeyConfigured(),
    model: DEFAULT_MODEL,
    documentiDir: getDocumentiDir(),
    supabase: useCloud(),
  });
}
