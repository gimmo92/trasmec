import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, getAnthropic, isApiKeyConfigured } from "./anthropic";
import { getJson, putJson, useCloud } from "./cloud";
import { extractPdfText } from "./orderpdf";

/** Riga dell'elenco parti del disegno: pale o scraper. */
export interface DrawingItem {
  code?: string;
  description: string;
  qty: number;
}

export interface DrawingInfo {
  file: string;
  /** Metratura dell'anello catena ("chain ring"), già convertita in metri. */
  chainRing?: { meters: number; text: string };
  /** Passo della maglia: distanza tra due occhielli, in mm. */
  pitchMm?: number;
  extras: DrawingItem[];
  source: "dwg" | "pdf" | "claude";
  warning?: string;
}

interface Cell {
  text: string;
  x?: number;
}

const DATA_FILE = path.join(process.cwd(), "data", "disegni.json");
const CLOUD_PATH = "config/disegni.json";
/** Va alzato quando cambia la lettura, così i disegni già visti vengono riletti. */
const CACHE_VERSION = 3;

let memory: Record<string, DrawingInfo & { key: string }> | null = null;

const CHAIN_RING = /chain\s*ring|anello\s*(di\s*)?catena/i;
const EXTRA = /\bpal[ae]\b|\bpaddles?\b|scrap/i;
const LENGTH_CELL = /^\s*(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(mm|m|mt)\s*\.?\s*$/i;
const LENGTH_ANY = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(mm|mt|m)(?![a-z/])/i;
const CODE = /^[A-Z]{2,}\d{3,}[A-Z0-9-]*$/;
const INT = /^\d+$/;

function num(value: string): number {
  return Number(value.replace(",", "."));
}

/** "2 x 45440mm" vale 45,44 m: il moltiplicatore del disegno non si applica. */
function toMeters(match: RegExpMatchArray): number {
  const value = num(match[2]);
  const meters = /^mm$/i.test(match[3]) ? value / 1000 : value;
  return Math.round(meters * 1000) / 1000;
}

/** Pale, scraper e anello catena da righe già divise in celle. */
export function readPartsRows(rows: Cell[][], qtyX?: number): Omit<DrawingInfo, "file" | "source"> {
  const extras: DrawingItem[] = [];
  let chainRing: DrawingInfo["chainRing"];
  let pitchMm: number | undefined;

  for (const cells of rows) {
    const texts = cells.map((c) => c.text.trim()).filter(Boolean);
    const joined = texts.join(" ");
    if (!joined) continue;

    const pitch = joined.match(/\b(?:pitch|passo(?:\s*maglia)?)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*mm\b/i);
    if (!pitchMm && pitch) pitchMm = num(pitch[1]);

    if (!chainRing && CHAIN_RING.test(joined) && !/weight|peso/i.test(joined)) {
      const cell = texts.map((t) => t.match(LENGTH_CELL)).find(Boolean) ?? joined.match(LENGTH_ANY);
      if (cell) chainRing = { meters: toMeters(cell), text: cell[0].trim() };
      continue;
    }

    if (EXTRA.test(joined)) {
      const ints = cells.filter((c) => INT.test(c.text.trim()));
      const qtyCell =
        qtyX !== undefined && ints.every((c) => c.x !== undefined)
          ? [...ints].sort((a, b) => Math.abs(a.x! - qtyX) - Math.abs(b.x! - qtyX))[0]
          : ints[ints.length - 1];
      const qty = qtyCell ? Number(qtyCell.text) : undefined;
      if (!qty) continue;
      const code = texts.find((t) => CODE.test(t));
      const description = texts.filter((t) => t !== code && t !== qtyCell?.text.trim() && !INT.test(t)).join(" / ");
      extras.push({ code, description: description || joined, qty });
    }
  }
  return { chainRing, pitchMm, extras };
}

function cleanMText(raw: string): string {
  return raw
    .replace(/\\P/g, " ")
    .replace(/\\[A-Za-z][^;\\]*;/g, "")
    .replace(/\\[LlOoKk]/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface DwgText {
  block: string;
  text: string;
  x: number;
  y: number;
  h: number;
}

interface DwgEntity {
  type: string;
  handle?: number | string;
  text?: string;
  measurement?: number;
  textHeight?: number;
  insertionPoint?: { x: number; y: number };
  startPoint?: { x: number; y: number };
}

async function dwgTexts(filePath: string): Promise<{ texts: DwgText[]; dims: number[] }> {
  const { LibreDwg, Dwg_File_Type } = await import("@mlightcad/libredwg-web");
  const wasmDir = path.join(process.cwd(), "node_modules", "@mlightcad", "libredwg-web", "wasm") + path.sep;
  const lib = await LibreDwg.create(wasmDir);
  const data = fs.readFileSync(filePath);
  const dwg = lib.dwg_read_data(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    Dwg_File_Type.DWG
  );
  if (!dwg) throw new Error("DWG non leggibile");
  try {
    const db = lib.convert(dwg) as unknown as {
      entities?: DwgEntity[];
      tables?: { BLOCK_RECORD?: { entries?: { name: string; entities?: DwgEntity[] }[] } };
    };
    const out: DwgText[] = [];
    const dims: number[] = [];
    const seen = new Set<string>();
    const add = (block: string, entities: DwgEntity[] | undefined) => {
      for (const e of entities ?? []) {
        if (/DIMENSION/i.test(e.type) && Number(e.measurement) > 0) dims.push(Number(e.measurement));
        if (e.type !== "MTEXT" && e.type !== "TEXT" && e.type !== "ATTRIB") continue;
        const text = cleanMText(String(e.text ?? ""));
        const p = e.insertionPoint ?? e.startPoint;
        if (!text || !p) continue;
        const key = `${e.handle ?? ""}:${text}:${p.x}:${p.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ block, text, x: p.x, y: p.y, h: e.textHeight || 2.5 });
      }
    };
    add("*Model_Space", db.entities);
    for (const record of db.tables?.BLOCK_RECORD?.entries ?? []) {
      if (/^\*model_space$/i.test(record.name)) continue;
      add(record.name, record.entities);
    }
    return { texts: out, dims };
  } finally {
    lib.dwg_free(dwg);
  }
}

/** Raggruppa i testi di ogni blocco in righe con la stessa quota Y. */
function dwgRows(texts: DwgText[]): { rows: Cell[][]; qtyX?: number }[] {
  const byBlock = new Map<string, DwgText[]>();
  for (const t of texts) byBlock.set(t.block, [...(byBlock.get(t.block) ?? []), t]);
  const tables: { rows: Cell[][]; qtyX?: number }[] = [];
  for (const items of byBlock.values()) {
    const sorted = [...items].sort((a, b) => b.y - a.y);
    const rows: DwgText[][] = [];
    for (const t of sorted) {
      const row = rows.find((r) => Math.abs(r[0].y - t.y) <= Math.max(r[0].h, t.h) * 0.6);
      if (row) row.push(t);
      else rows.push([t]);
    }
    const header = items.find((t) => /^(qty|q\.?\s*t[àa]?\.?|quantit[àa]?)$/i.test(t.text));
    tables.push({
      rows: rows.map((r) => r.sort((a, b) => a.x - b.x).map((t) => ({ text: t.text, x: t.x }))),
      qtyX: header?.x,
    });
  }
  return tables;
}

async function readDwg(filePath: string): Promise<Omit<DrawingInfo, "file" | "source">> {
  const { texts, dims } = await dwgTexts(filePath);
  const extras: DrawingItem[] = [];
  let chainRing: DrawingInfo["chainRing"];
  let pitchMm: number | undefined;
  for (const table of dwgRows(texts)) {
    const res = readPartsRows(table.rows, table.qtyX);
    chainRing ??= res.chainRing;
    pitchMm ??= res.pitchMm;
    extras.push(...res.extras);
  }
  // Passo maglia: le prime 3 cifre del tipo catena (14226 → 142), se quotato nel disegno.
  if (!pitchMm) {
    for (const t of texts) {
      const m = t.text.match(/\b(\d{3})\d{2}\s*MN\b/i);
      const candidate = m ? Number(m[1]) : 0;
      if (candidate && dims.some((d) => Math.abs(d - candidate) < 0.5)) {
        pitchMm = candidate;
        break;
      }
    }
  }
  return { chainRing, pitchMm, extras };
}

const VISION_PROMPT = `Questo è un disegno tecnico Trasmec di una catena o di una macchina.
Rispondi solo con JSON, senza testo prima o dopo:
{"chainRing": {"text": "testo esatto della quantità", "meters": numero} | null,
 "pitchMm": numero | null,
 "items": [{"code": "codice o null", "description": "descrizione", "qty": numero}]}

chainRing: la quantità della voce "chain ring" / "anello catena" nell'elenco parti, convertita in metri
senza applicare moltiplicatori come "2 x" (es. "2 x 45440mm" = 45.44). Se quella voce non c'è, usa lo sviluppo della catena scritto come
"DEVELOPMENT" o "SVILUPPO" (es. "DEVELOPMENT : 37,062m" = 37.062). Se non c'è nessuno dei due, null.
pitchMm: il passo della maglia della catena in mm, cioè la distanza tra i due occhielli (perni) di una
maglia, come quotato nel disegno (es. 142). Se non è quotato, null.
items: solo le righe dell'elenco parti che parlano di pale (pala, pale, paddle) o scraper/scrape,
con la quantità scritta nel disegno. Ometti le righe con quantità vuota o "-". Non inventare valori.`;

async function readPdfWithClaude(filePath: string): Promise<Omit<DrawingInfo, "file" | "source">> {
  const msg = await getAnthropic().messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(filePath).toString("base64") },
          },
          { type: "text", text: VISION_PROMPT },
        ],
      },
    ],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Risposta Claude senza JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    chainRing?: { text?: string; meters?: number } | null;
    pitchMm?: number | null;
    items?: { code?: string | null; description?: string; qty?: number }[];
  };
  const meters = Number(parsed.chainRing?.meters);
  const pitch = Number(parsed.pitchMm);
  return {
    pitchMm: Number.isFinite(pitch) && pitch > 0 ? pitch : undefined,
    chainRing:
      Number.isFinite(meters) && meters > 0
        ? { meters, text: String(parsed.chainRing?.text ?? `${meters} m`) }
        : undefined,
    extras: (parsed.items ?? [])
      .filter((i) => Number(i.qty) > 0)
      .map((i) => ({ code: i.code || undefined, description: String(i.description ?? ""), qty: Number(i.qty) })),
  };
}

async function readPdf(filePath: string): Promise<Omit<DrawingInfo, "file">> {
  const text = await extractPdfText(filePath);
  const content = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "").trim();
  if (content.length >= 30) {
    const rows = content
      .split(/\r?\n/)
      .map((line) => line.split(/\t| {2,}/).map((t) => ({ text: t })));
    return { ...readPartsRows(rows), source: "pdf" };
  }
  if (!isApiKeyConfigured()) {
    return { extras: [], source: "pdf", warning: "PDF senza testo: serve Claude per leggerlo (API key mancante)." };
  }
  return { ...(await readPdfWithClaude(filePath)), source: "claude" };
}

function readLocalCache(): Record<string, DrawingInfo & { key: string }> {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function loadCache(): Promise<Record<string, DrawingInfo & { key: string }>> {
  if (memory) return memory;
  const remote = useCloud() ? await getJson<Record<string, DrawingInfo & { key: string }>>(CLOUD_PATH) : null;
  memory = remote && typeof remote === "object" ? remote : readLocalCache();
  return memory;
}

async function saveCache(cache: Record<string, DrawingInfo & { key: string }>): Promise<void> {
  memory = cache;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
  if (useCloud()) await putJson(CLOUD_PATH, cache);
}

/** Legge i disegni (DWG o PDF) e ricorda il risultato per nome e dimensione. */
export async function readDrawings(files: { name: string; full: string }[]): Promise<Map<string, DrawingInfo>> {
  const cache = await loadCache();
  const out = new Map<string, DrawingInfo>();
  let dirty = false;
  await Promise.all(
    files.map(async (file) => {
      const stat = fs.statSync(file.full);
      const key = `v${CACHE_VERSION}:${stat.size}`;
      const hit = cache[file.name];
      if (hit?.key === key) {
        out.set(file.name, hit);
        return;
      }
      let info: DrawingInfo;
      try {
        const res = /\.dwg$/i.test(file.name)
          ? { ...(await readDwg(file.full)), source: "dwg" as const }
          : await readPdf(file.full);
        info = { file: file.name, ...res };
      } catch (err) {
        info = {
          file: file.name,
          extras: [],
          source: /\.dwg$/i.test(file.name) ? "dwg" : "pdf",
          warning: `Disegno non letto: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      out.set(file.name, info);
      if (!info.warning) {
        cache[file.name] = { ...info, key };
        dirty = true;
      }
    })
  );
  if (dirty) await saveCache(cache);
  return out;
}
