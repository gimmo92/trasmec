import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readArchivio } from "./archivio";
import { getJson, putJson, useCloud } from "./cloud";
import { resolveDocumento } from "./documenti";
import { parseOrderPdf } from "./orderpdf";
import type { OrdineGenerato, OrdineMacchina } from "./types";

const DATA_FILE = path.join(process.cwd(), "data", "ordini.json");
const CLOUD_PATH = "config/ordini.json";

let memory: OrdineGenerato[] | null = null;

function beCode(name: string): string | undefined {
  return name.match(/BE\d{4}/i)?.[0].toUpperCase();
}

function readLocal(): OrdineGenerato[] {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as OrdineGenerato[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function load(): Promise<OrdineGenerato[]> {
  if (memory) return memory;
  if (useCloud()) {
    const remote = await getJson<OrdineGenerato[]>(CLOUD_PATH);
    if (Array.isArray(remote)) {
      memory = remote;
      return remote;
    }
  }
  memory = readLocal();
  return memory;
}

async function save(rows: OrdineGenerato[]): Promise<void> {
  memory = rows;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
  if (useCloud()) await putJson(CLOUD_PATH, rows);
}

export async function listOrdini(): Promise<OrdineGenerato[]> {
  const rows = await load();
  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getOrdine(id: string): Promise<OrdineGenerato | null> {
  const rows = await load();
  return rows.find((row) => row.id === id) ?? null;
}

/** Crea o aggiorna l'ordine a partire dal PDF e dalle distinte associate. */
export async function generaOrdine(sourceFile: string): Promise<OrdineGenerato> {
  const name = sourceFile.trim();
  const archivio = await readArchivio();
  const source = archivio.ordini.find((file) => file.name === name);
  if (!source) throw new Error("Documento d'ordine non trovato nell'archivio");

  const linked = archivio.distinte.filter((file) => file.ordini.includes(name));
  if (!linked.length) throw new Error("Associa almeno una distinta prima di generare l'ordine");

  const macchine: OrdineMacchina[] = [];
  for (const file of linked) {
    const code = (file.code || beCode(file.name) || "").toUpperCase();
    if (!/^BE\d{4}$/.test(code)) {
      throw new Error(`Nella distinta ${file.name} non c'è un codice BE####`);
    }
    if (macchine.some((row) => row.code === code)) continue;
    macchine.push({ code, file: file.name });
  }

  const parsed = await parseOrderPdf(resolveDocumento(name));
  const now = new Date().toISOString();
  const rows = await load();
  const existing = rows.find((row) => row.sourceFile === name);
  const next: OrdineGenerato = {
    id: existing?.id ?? randomUUID(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    sourceFile: name,
    orderNumber: parsed.header.orderNumber,
    orderDate: parsed.header.orderDate,
    customer: parsed.header.customer,
    projectName: parsed.header.projectName,
    macchine,
  };
  const stored = existing
    ? rows.map((row) => (row.id === existing.id ? next : row))
    : [...rows, next];
  await save(stored);
  return next;
}
