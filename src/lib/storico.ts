import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getJson, putJson, useCloud } from "./cloud";
import type { Offer, OffertaStorico, OffertaStoricoVoce } from "./types";

const DATA_FILE = path.join(process.cwd(), "data", "storico.json");
const CLOUD_PATH = "config/storico.json";

let memory: OffertaStorico[] | null = null;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function isOffer(value: unknown): value is Offer {
  if (!value || typeof value !== "object") return false;
  const offer = value as Offer;
  return Boolean(offer.header) && typeof offer.header === "object" && Array.isArray(offer.machines);
}

function isStored(value: unknown): value is OffertaStorico {
  if (!value || typeof value !== "object") return false;
  const row = value as OffertaStorico;
  return typeof row.id === "string" && typeof row.savedAt === "string" && isOffer(row.offer);
}

export function storicoVoce(row: OffertaStorico): OffertaStoricoVoce {
  return {
    id: row.id,
    savedAt: row.savedAt,
    updatedAt: row.updatedAt,
    orderNumber: row.orderNumber,
    customer: row.customer,
    projectName: row.projectName,
    orderDate: row.orderDate,
    sourceFile: row.sourceFile,
  };
}

function fromOffer(offer: Offer, id: string, savedAt: string, updatedAt: string): OffertaStorico {
  const source = offer.meta?.orderFile;
  return {
    id,
    savedAt,
    updatedAt,
    orderNumber: offer.header.orderNumber,
    customer: offer.header.customer,
    projectName: offer.header.projectName,
    orderDate: offer.header.orderDate,
    sourceFile: typeof source === "string" ? source : undefined,
    offer,
  };
}

function readLocal(): OffertaStorico[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStored);
  } catch {
    return [];
  }
}

async function load(): Promise<OffertaStorico[]> {
  if (memory) return memory;
  if (useCloud()) {
    const remote = await getJson<unknown>(CLOUD_PATH);
    if (Array.isArray(remote)) {
      memory = remote.filter(isStored);
      return memory;
    }
  }
  memory = readLocal();
  return memory;
}

async function save(rows: OffertaStorico[]): Promise<void> {
  memory = rows;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
  if (useCloud()) await putJson(CLOUD_PATH, rows);
}

function byRecent(rows: OffertaStorico[]): OffertaStorico[] {
  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listStorico(): Promise<OffertaStoricoVoce[]> {
  return enqueue(async () => byRecent(await load()).map(storicoVoce));
}

export function getStorico(id: string): Promise<OffertaStorico | null> {
  return enqueue(async () => (await load()).find((row) => row.id === id) ?? null);
}

/** Crea una voce nuova, oppure aggiorna quella con lo stesso id. */
export function saveStorico(offer: Offer, id?: string): Promise<OffertaStorico> {
  return enqueue(async () => {
    if (!isOffer(offer)) throw new Error("Offerta non valida");
    const rows = await load();
    const now = new Date().toISOString();
    const existing = id ? rows.find((row) => row.id === id) : undefined;
    if (id && !existing) throw new Error("Offerta non trovata nello storico");
    const next = fromOffer(offer, existing?.id ?? randomUUID(), existing?.savedAt ?? now, now);
    const stored = existing
      ? rows.map((row) => (row.id === existing.id ? next : row))
      : [...rows, next];
    await save(stored);
    return next;
  });
}

export function deleteStorico(id: string): Promise<boolean> {
  return enqueue(async () => {
    const rows = await load();
    if (!rows.some((row) => row.id === id)) return false;
    await save(rows.filter((row) => row.id !== id));
    return true;
  });
}
