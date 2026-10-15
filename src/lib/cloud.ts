import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const CLOUD_BUCKET = "trasmec";

let client: SupabaseClient | null = null;
let bucketReady = false;

export function useCloud(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function supabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase non configurato");
  }
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const sb = supabaseAdmin();
  const existing = await sb.storage.getBucket(CLOUD_BUCKET);
  if (!existing.data) {
    const created = await sb.storage.createBucket(CLOUD_BUCKET, { public: false });
    if (created.error && !/already exists/i.test(created.error.message)) {
      throw new Error(`Bucket Supabase: ${created.error.message}`);
    }
  }
  bucketReady = true;
}

export async function getJson<T>(objectPath: string): Promise<T | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage.from(CLOUD_BUCKET).download(objectPath);
  if (error) {
    if (/not found|does not exist/i.test(error.message)) return null;
    throw new Error(`Lettura ${objectPath}: ${error.message}`);
  }
  const text = await data.text();
  return JSON.parse(text) as T;
}

export async function putJson(objectPath: string, value: unknown): Promise<void> {
  const sb = supabaseAdmin();
  const body = Buffer.from(JSON.stringify(value, null, 2), "utf8");
  const { error } = await sb.storage.from(CLOUD_BUCKET).upload(objectPath, body, {
    upsert: true,
    contentType: "application/json",
  });
  if (error) throw new Error(`Scrittura ${objectPath}: ${error.message}`);
}

export async function listStorage(prefix: string): Promise<Map<string, number>> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage.from(CLOUD_BUCKET).list(prefix, { limit: 200 });
  if (error) throw new Error(`Elenco ${prefix}: ${error.message}`);
  const out = new Map<string, number>();
  for (const item of data ?? []) {
    if (!item.name || item.name.startsWith(".")) continue;
    if (item.id == null) continue;
    const meta = item.metadata as { size?: number; contentLength?: number } | null;
    const size = Number(meta?.size ?? meta?.contentLength ?? 0);
    out.set(item.name, size);
  }
  return out;
}

export async function uploadFile(objectPath: string, filePath: string): Promise<void> {
  const sb = supabaseAdmin();
  const body = fs.readFileSync(filePath);
  const { error } = await sb.storage.from(CLOUD_BUCKET).upload(objectPath, body, {
    upsert: true,
    contentType: "application/octet-stream",
  });
  if (error) throw new Error(`Upload ${objectPath}: ${error.message}`);
}

/** URL firmato per caricare un file dal browser senza passare dal limite della funzione. */
export async function signedUploadUrl(objectPath: string): Promise<string> {
  await ensureBucket();
  const { data, error } = await supabaseAdmin()
    .storage.from(CLOUD_BUCKET)
    .createSignedUploadUrl(objectPath, { upsert: true });
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "URL di caricamento non disponibile");
  }
  return data.signedUrl;
}

export async function downloadFile(objectPath: string): Promise<Buffer | null> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage.from(CLOUD_BUCKET).download(objectPath);
  if (error) {
    if (/not found|does not exist/i.test(error.message)) return null;
    throw new Error(`Download ${objectPath}: ${error.message}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

export function cloudTmpDir(): string {
  return path.join(os.tmpdir(), "trasmec-documenti");
}
