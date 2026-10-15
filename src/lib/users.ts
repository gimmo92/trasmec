import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ensureBucket, getJson, putJson, useCloud } from "./cloud";

const scryptAsync = promisify(scrypt);
const DATA_FILE = path.join(process.cwd(), "data", "utenti.json");
const CLOUD_PATH = "config/utenti.json";
const DUMMY_HASH =
  "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface PublicUser {
  email: string;
  createdAt: string;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateNewAccount(email: string, password: string): string {
  const normalized = normalizeEmail(email);
  if (!isEmail(normalized)) throw new Error("Inserisci un'email valida");
  if (password.length < 8) throw new Error("La password deve avere almeno 8 caratteri");
  if (password.length > 200) throw new Error("Password troppo lunga");
  return normalized;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const hash = (await scryptAsync(password, salt, 32)) as Buffer;
  return `scrypt$${salt}$${hash.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash || password.length === 0 || password.length > 200) {
    return false;
  }
  const actual = (await scryptAsync(password, salt, 32)) as Buffer;
  const expected = Buffer.from(hash, "base64url");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function normalizeList(raw: unknown): StoredUser[] {
  if (!Array.isArray(raw)) return [];
  const users: StoredUser[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const item = row as Partial<StoredUser>;
    const email = normalizeEmail(String(item.email ?? ""));
    const passwordHash = String(item.passwordHash ?? "");
    if (!isEmail(email) || !passwordHash.startsWith("scrypt$")) continue;
    users.push({
      id: item.id || randomUUID(),
      email,
      passwordHash,
      createdAt: item.createdAt || new Date().toISOString(),
    });
  }
  return users;
}

function readLocal(): StoredUser[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  return normalizeList(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
}

function writeLocal(users: StoredUser[]) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
}

async function readUsers(): Promise<StoredUser[]> {
  if (useCloud()) {
    await ensureBucket();
    const remote = await getJson<unknown>(CLOUD_PATH);
    if (Array.isArray(remote)) return normalizeList(remote);
    const local = readLocal();
    if (local.length) await putJson(CLOUD_PATH, local);
    return local;
  }
  return readLocal();
}

async function writeUsers(users: StoredUser[]): Promise<void> {
  writeLocal(users);
  if (useCloud()) {
    await ensureBucket();
    await putJson(CLOUD_PATH, users);
  }
}

export async function hasUsers(): Promise<boolean> {
  const users = await readUsers();
  return users.length > 0;
}

export async function listPublicUsers(): Promise<PublicUser[]> {
  const users = await readUsers();
  return users.map((user) => ({ email: user.email, createdAt: user.createdAt }));
}

export async function authenticate(email: string, password: string): Promise<StoredUser | null> {
  const normalized = normalizeEmail(email);
  const users = await readUsers();
  const user = users.find((item) => item.email === normalized) ?? null;
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !isEmail(normalized)) return null;
  return user;
}

export async function createUser(email: string, password: string): Promise<StoredUser> {
  const normalized = validateNewAccount(email, password);
  const users = await readUsers();
  if (users.some((user) => user.email === normalized)) {
    throw new Error("Esiste già un account con questa email");
  }
  const user: StoredUser = {
    id: randomUUID(),
    email: normalized,
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await writeUsers(users);
  return user;
}

export async function deleteUser(email: string): Promise<void> {
  const normalized = normalizeEmail(email);
  const users = await readUsers();
  if (users.length <= 1) throw new Error("Deve restare almeno un account");
  const next = users.filter((user) => user.email !== normalized);
  if (next.length === users.length) throw new Error("Account non trovato");
  await writeUsers(next);
}
