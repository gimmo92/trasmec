export const SESSION_COOKIE = "trasmec_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 14;

/** Firma i cookie. In produzione usa AUTH_SECRET o la service role già presente su Vercel. */
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") return "trasmec-dev-only";
  return "";
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padLen = (4 - (value.length % 4)) % 4;
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat(padLen);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(sig));
}

export async function signSession(email: string): Promise<string> {
  const secret = authSecret();
  if (!secret) throw new Error("Autenticazione non configurata");
  const payload = bytesToBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ email, exp: Date.now() + SESSION_MAX_AGE * 1000 })
    )
  );
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

/** Email della sessione, oppure null se il cookie manca, è scaduto o non è firmato. */
export async function readSession(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  const secret = authSecret();
  if (!secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, payload);
  if (!safeEqual(sig, expected)) return null;
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(payload));
    const data = JSON.parse(json) as { email?: unknown; exp?: unknown };
    if (typeof data.email !== "string" || typeof data.exp !== "number") return null;
    if (data.exp < Date.now()) return null;
    return data.email;
  } catch {
    return null;
  }
}
