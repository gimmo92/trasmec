import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getJson, putJson, useCloud } from "./cloud";
import type { SpareSiglaRow } from "./types";

const DATA_FILE = path.join(process.cwd(), "data", "sigle-spare-parts.json");
const CLOUD_PATH = "config/sigle.json";

/** Sigle attuali del filtro 1 (prefisso part number in distinta). */
export const DEFAULT_SIGLE = [
  "SC",
  "RN",
  "SA",
  "TP",
  "CA",
  "R0",
  "CT",
  "CU",
  "C0",
];

let cache: SpareSiglaRow[] | null = null;
let fromCloud = false;

function normalizeRow(row: Partial<SpareSiglaRow> & { id?: string }): SpareSiglaRow {
  return {
    id: row.id || randomUUID(),
    n: typeof row.n === "number" && Number.isFinite(row.n) ? row.n : 0,
    sigla: String(row.sigla ?? "")
      .trim()
      .toUpperCase(),
  };
}

function seedRows(): SpareSiglaRow[] {
  return DEFAULT_SIGLE.map((sigla, i) =>
    normalizeRow({ n: i + 1, sigla, id: randomUUID() })
  );
}

function writeAll(rows: SpareSiglaRow[]) {
  cache = rows;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
}

async function persist(rows: SpareSiglaRow[]) {
  fromCloud = useCloud();
  writeAll(rows);
  if (useCloud()) await putJson(CLOUD_PATH, rows);
}

export async function hydrateSigle(): Promise<void> {
  const remote = await getJson<Partial<SpareSiglaRow>[]>(CLOUD_PATH);
  if (Array.isArray(remote)) {
    cache = remote.map((row) => normalizeRow(row));
    fromCloud = true;
    return;
  }
  const local = ensureFile();
  cache = local;
  fromCloud = true;
  await putJson(CLOUD_PATH, local);
}

function ensureFile(): SpareSiglaRow[] {
  if (cache) return cache;
  if (!fs.existsSync(DATA_FILE)) {
    const seeded = seedRows();
    writeAll(seeded);
    return seeded;
  }
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw) as Partial<SpareSiglaRow>[];
  if (!Array.isArray(parsed)) {
    cache = [];
    return cache;
  }
  cache = parsed.map((row) => normalizeRow(row));
  return cache;
}

export function listSigle(): SpareSiglaRow[] {
  if (fromCloud && cache) return cache;
  return ensureFile();
}

/** Prefissi non vuoti, uppercase, usati dal filtro 1 sulla distinta. */
export function listSigleCodes(): string[] {
  return listSigle()
    .map((r) => r.sigla.trim().toUpperCase())
    .filter(Boolean);
}

export async function createSigla(input: Partial<SpareSiglaRow> = {}): Promise<SpareSiglaRow> {
  const rows = listSigle();
  const nextN =
    rows.reduce((max, r) => (Number.isFinite(r.n) && r.n > max ? r.n : max), 0) + 1;
  const row = normalizeRow({
    id: randomUUID(),
    n: typeof input.n === "number" && Number.isFinite(input.n) ? input.n : nextN,
    sigla: input.sigla ?? "",
  });
  const next = [...rows, row];
  await persist(next);
  return row;
}

export async function updateSigla(
  id: string,
  patch: Partial<SpareSiglaRow>
): Promise<SpareSiglaRow | null> {
  const rows = listSigle();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const current = rows[idx];
  const updated = normalizeRow({
    ...current,
    n:
      typeof patch.n === "number" && Number.isFinite(patch.n)
        ? patch.n
        : current.n,
    sigla: patch.sigla !== undefined ? patch.sigla : current.sigla,
    id: current.id,
  });
  const next = [...rows];
  next[idx] = updated;
  await persist(next);
  return updated;
}

export async function deleteSigla(id: string): Promise<boolean> {
  const rows = listSigle();
  const next = rows.filter((r) => r.id !== id);
  if (next.length === rows.length) return false;
  await persist(next);
  return true;
}
