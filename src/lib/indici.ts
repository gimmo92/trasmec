import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getJson, putJson, useCloud } from "./cloud";
import type { SpareIndexRow, SparePartsFlag } from "./types";

export const GESTIONE_OPTIONS = [
  "Composto",
  "Composto + gruppo cuscinetti",
  "Unico",
  "Unico + gruppo cuscinetti",
  "Gestione separata",
] as const;

const DATA_FILE = path.join(process.cwd(), "data", "indici-ricambi.json");
const CLOUD_PATH = "config/indici.json";

let fromCloud = false;
let cloudRows: SpareIndexRow[] | null = null;
/** Le scritture in corso non vanno coperte da una rilettura cloud più vecchia. */
let epoch = 0;
let writing = 0;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const SEED: Omit<SpareIndexRow, "id">[] = [
  { n: 1, indice: "SECTOR", descrizioneOfferta: "KIT SETTORI", gestione: "Composto", sparePartsList: "SI", strutturaDescrizione: "", note: "" },
  { n: 2, indice: "TM", descrizioneOfferta: "SUPPORTI 1", gestione: "Composto + gruppo cuscinetti", sparePartsList: "SI", strutturaDescrizione: "", note: "" },
  { n: 3, indice: "SN  FN  UKT", descrizioneOfferta: "SUPPORTI 2", gestione: "Unico + gruppo cuscinetti", sparePartsList: "SI", strutturaDescrizione: "", note: "" },
  { n: 4, indice: "TRASPORT CHAIN CONVEYING CHAIN", descrizioneOfferta: "CATENA", gestione: "Gestione separata", sparePartsList: "SI", strutturaDescrizione: "Chain {modello}", note: "" },
  { n: 4, indice: "TP", descrizioneOfferta: "TAPPETO", gestione: "Unico", sparePartsList: "NO", strutturaDescrizione: "", note: "" },
  { n: 5, indice: "SPAZ", descrizioneOfferta: "KIT SPAZZOLE", gestione: "Composto", sparePartsList: "SI", strutturaDescrizione: "", note: "" },
  { n: 6, indice: "SPRINKLER", descrizioneOfferta: "SPRINKLERS", gestione: "Unico", sparePartsList: "SI", strutturaDescrizione: "", note: "" },
  { n: 7, indice: "D135 TK-R", descrizioneOfferta: "SUPPORTI 3", gestione: "Composto + gruppo cuscinetti", sparePartsList: "SI", strutturaDescrizione: "Support {modello}", note: "D135 in distinta = TKK Ø=135 in listino" },
  { n: 8, indice: "SCRAPER", descrizioneOfferta: "SCRAPER", gestione: "Unico", sparePartsList: "SI", strutturaDescrizione: "", note: "" },
];

function normalizeRow(row: Partial<SpareIndexRow> & { id?: string }): SpareIndexRow {
  return {
    id: row.id || randomUUID(),
    n: typeof row.n === "number" && Number.isFinite(row.n) ? row.n : 0,
    indice: String(row.indice ?? ""),
    descrizioneOfferta: String(row.descrizioneOfferta ?? ""),
    gestione: String(row.gestione ?? GESTIONE_OPTIONS[0]),
    sparePartsList: row.sparePartsList === "NO" ? "NO" : "SI",
    strutturaDescrizione: String(row.strutturaDescrizione ?? ""),
    note: String(row.note ?? ""),
  };
}

function ensureFile(): SpareIndexRow[] {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const seeded = SEED.map((row) => normalizeRow({ ...row, id: randomUUID() }));
    fs.writeFileSync(DATA_FILE, JSON.stringify(seeded, null, 2), "utf8");
    return seeded;
  }
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw) as Partial<SpareIndexRow>[];
  if (!Array.isArray(parsed)) return [];
  const rows = parsed.map((row) => normalizeRow(row));
  const needsWrite = parsed.some((row) => row.strutturaDescrizione === undefined);
  if (needsWrite) writeAll(rows);
  return rows;
}

function writeAll(rows: SpareIndexRow[]) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
}

async function persist(rows: SpareIndexRow[]) {
  const copy = rows.map((row) => ({ ...row }));
  writing += 1;
  epoch += 1;
  cloudRows = copy;
  fromCloud = useCloud();
  try {
    writeAll(copy);
    if (useCloud()) await putJson(CLOUD_PATH, copy);
  } finally {
    writing -= 1;
  }
}

export async function hydrateIndici(): Promise<void> {
  const seen = epoch;
  const remote = await getJson<Partial<SpareIndexRow>[]>(CLOUD_PATH);
  if (seen !== epoch || writing > 0) return;
  if (Array.isArray(remote)) {
    cloudRows = remote.map((row) => normalizeRow(row));
    fromCloud = true;
    return;
  }
  const local = ensureFile();
  cloudRows = local;
  fromCloud = true;
  await putJson(CLOUD_PATH, local);
}

export function listIndici(): SpareIndexRow[] {
  if (fromCloud && cloudRows) return cloudRows;
  return ensureFile();
}

export async function createIndice(input: Partial<SpareIndexRow>): Promise<SpareIndexRow> {
  return enqueue(async () => {
    const rows = listIndici().map((row) => ({ ...row }));
    const nextN =
      rows.reduce((max, r) => (Number.isFinite(r.n) && r.n > max ? r.n : max), 0) + 1;
    const row: SpareIndexRow = {
      id: randomUUID(),
      n: typeof input.n === "number" && Number.isFinite(input.n) ? input.n : nextN,
      indice: (input.indice ?? "").trim(),
      descrizioneOfferta: (input.descrizioneOfferta ?? "").trim(),
      gestione: (input.gestione ?? GESTIONE_OPTIONS[0]).trim(),
      sparePartsList: input.sparePartsList === "NO" ? "NO" : "SI",
      strutturaDescrizione: (input.strutturaDescrizione ?? "").trim(),
      note: (input.note ?? "").trim(),
    };
    rows.push(row);
    await persist(rows);
    return row;
  });
}

export async function updateIndice(
  id: string,
  patch: Partial<SpareIndexRow>
): Promise<SpareIndexRow | null> {
  return enqueue(async () => {
    const rows = listIndici().map((row) => ({ ...row }));
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const current = rows[idx];
    const flag: SparePartsFlag =
      patch.sparePartsList === "NO" || patch.sparePartsList === "SI"
        ? patch.sparePartsList
        : current.sparePartsList;
    const updated: SpareIndexRow = {
      ...current,
      n:
        typeof patch.n === "number" && Number.isFinite(patch.n)
          ? patch.n
          : current.n,
      indice: patch.indice !== undefined ? String(patch.indice) : current.indice,
      descrizioneOfferta:
        patch.descrizioneOfferta !== undefined
          ? String(patch.descrizioneOfferta)
          : current.descrizioneOfferta,
      gestione:
        patch.gestione !== undefined ? String(patch.gestione) : current.gestione,
      sparePartsList: flag,
      strutturaDescrizione:
        patch.strutturaDescrizione !== undefined
          ? String(patch.strutturaDescrizione)
          : current.strutturaDescrizione,
      note: patch.note !== undefined ? String(patch.note) : current.note,
    };
    rows[idx] = updated;
    await persist(rows);
    return updated;
  });
}

export async function deleteIndice(id: string): Promise<boolean> {
  return enqueue(async () => {
    const rows = listIndici();
    const next = rows.filter((r) => r.id !== id);
    if (next.length === rows.length) return false;
    await persist(next);
    return true;
  });
}
