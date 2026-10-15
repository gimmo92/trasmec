import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE, SESSION_MAX_AGE, signSession } from "./sessiontoken";

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_MAX_AGE,
};

export async function startSession(email: string): Promise<void> {
  const token = await signSession(email);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions);
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}

export async function currentEmail(): Promise<string | null> {
  const jar = await cookies();
  return readSession(jar.get(SESSION_COOKIE)?.value);
}
