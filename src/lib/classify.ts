import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { getJson, putJson, useCloud } from "./cloud";
import { extractPdfText } from "./orderpdf";
import type { DocumentoFile } from "./types";

export type DocKind = DocumentoFile["kind"];

export interface ClassifiedDoc {
  kind: DocKind;
  code?: string;
  codes?: string[];
}

interface CacheEntry extends ClassifiedDoc {
  size: number;
  mtime: number;
}

const DATA_FILE = path.join(process.cwd(), "data", "classificazione.json");
const CLOUD_PATH = "config/classificazione.json";

let memory: Record<string, CacheEntry> | null = null;

function beCode(text: string): string | undefined {
  const match = text.match(/BE\d{4}/i);
  return match?.[0].toUpperCase();
}

/** Codici macchina dell'ordine: dopo AFTER SALES, altrimenti tutti i BE#### trovati. */
function orderCodes(text: string): string[] {
  const marker = text.search(/AFTER\s*SALES/i);
  const slice = marker >= 0 ? text.slice(marker) : text;
  const found: string[] = [];
  for (const match of slice.matchAll(/BE\d{4}/gi)) {
    const code = match[0].toUpperCase();
    if (!found.includes(code)) found.push(code);
  }
  return found;
}

/** Classificazione di riserva quando il contenuto non si lascia leggere. */
export function kindFromName(name: string): ClassifiedDoc {
  const n = name.toLowerCase();
  const code = beCode(name);
  if (n.endsWith(".pdf")) return { kind: "altro" };
  if (n.includes("-ml") || n.includes("motor")) return { kind: "lista-motori" };
  if (n.includes("-sl") || n.includes("sensor")) return { kind: "lista-sensori" };
  if (n.includes("spare") || n.includes("listino") || n.includes("price")) return { kind: "listino" };
  if (/^be\d+/i.test(name) || n.endsWith(".xlsm")) return { kind: "distinta", code };
  return { kind: "altro", code };
}

function sheetNames(filePath: string): string[] {
  const wb = XLSX.readFile(filePath, { bookSheets: true });
  return wb.SheetNames ?? [];
}

function peekSheet(filePath: string, sheet: string): string {
  const wb = XLSX.readFile(filePath, {
    sheets: [sheet],
    sheetRows: 30,
    cellDates: true,
    cellFormula: false,
  });
  const ws = wb.Sheets[sheet];
  if (!ws) return "";
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: false,
  });
  return rows
    .flat()
    .map((cell) => (cell == null ? "" : String(cell)))
    .join("\n")
    .slice(0, 12000);
}

function classifyExcel(filePath: string, name: string): ClassifiedDoc {
  const names = sheetNames(filePath);
  const lower = names.map((sheet) => sheet.toLowerCase().trim());
  const codeInName = beCode(name);

  const distintaSheet = names.find((sheet) =>
    /^(parts only|structured|bom index)$/i.test(sheet.trim())
  );
  if (distintaSheet) {
    const codeSheet =
      names.find((sheet) => /^(bom index|1)$/i.test(sheet.trim())) ?? distintaSheet;
    const peeked = codeInName ? "" : peekSheet(filePath, codeSheet);
    return { kind: "distinta", code: codeInName ?? beCode(peeked) };
  }

  if (lower.includes("ml")) return { kind: "lista-motori", code: codeInName };
  if (lower.includes("sl")) return { kind: "lista-sensori", code: codeInName };

  const sampleSheet =
    names.find((sheet) => sheet.trim() === "1") ??
    names.find((sheet) => !/^xl\/|macro/i.test(sheet)) ??
    names[0];
  const peeked = sampleSheet ? peekSheet(filePath, sampleSheet) : "";
  const blob = `${name}\n${names.join("\n")}\n${peeked}`.toLowerCase();
  const code = codeInName ?? beCode(`${name}\n${peeked}`);

  if (/part number/.test(blob) && /description|qty|job nr|plate nr/.test(blob)) {
    return { kind: "distinta", code };
  }
  if (/job nr|plate nr|bom index/.test(blob) && /be\d{4}/i.test(blob)) {
    return { kind: "distinta", code };
  }
  // Scheda di configurazione (foglio "1"): Job / Serial Number / Machine Code, senza "Parts only".
  if (lower.includes("1") && /be\d{4}/i.test(blob) && /\bjob\b|serial number|machine code/.test(blob)) {
    return { kind: "distinta", code };
  }
  if (/\bcodice\b/.test(blob) && /disegno/.test(blob)) return { kind: "listino", code };
  if (lower.some((sheet) => /supporti|listino|spare/.test(sheet))) {
    return { kind: "listino", code };
  }
  return kindFromName(name);
}

async function classifyPdf(filePath: string, name: string): Promise<ClassifiedDoc> {
  const text = (await extractPdfText(filePath)).slice(0, 40000);
  const codes = orderCodes(text);
  if (/AFTER\s*SALES/i.test(text) || /NR\.\s*DOCUMENTO/i.test(text)) {
    return { kind: "ordine", code: codes[0], codes };
  }
  if (codes.length && /COMMESSA|ORDINE|ORDER\s+CONFIRMATION/i.test(text)) {
    return { kind: "ordine", code: codes[0], codes };
  }
  if (/offerta\s+commerciale/i.test(text) || /template/i.test(name)) return { kind: "template" };
  return { kind: "altro" };
}

/** Guarda il contenuto, non solo il nome: distinta, ordine, listino, motori, sensori. */
export async function classifyFile(filePath: string, name: string): Promise<ClassifiedDoc> {
  const ext = path.extname(name).toLowerCase();
  try {
    if (ext === ".pdf") return await classifyPdf(filePath, name);
    if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") return classifyExcel(filePath, name);
  } catch {
    return kindFromName(name);
  }
  return kindFromName(name);
}

function readLocalCache(): Record<string, CacheEntry> {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Record<string, CacheEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function loadCache(): Promise<Record<string, CacheEntry>> {
  if (memory) return memory;
  if (useCloud()) {
    const remote = await getJson<Record<string, CacheEntry>>(CLOUD_PATH);
    if (remote && typeof remote === "object" && !Array.isArray(remote)) {
      memory = remote;
      return remote;
    }
  }
  memory = readLocalCache();
  return memory;
}

async function saveCache(cache: Record<string, CacheEntry>): Promise<void> {
  memory = cache;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
  if (useCloud()) await putJson(CLOUD_PATH, cache);
}

export function cachedKind(name: string, size: number, mtimeMs: number): ClassifiedDoc | null {
  const hit = memory?.[name];
  if (!hit || hit.size !== size || hit.mtime !== mtimeMs) return null;
  return { kind: hit.kind, code: hit.code, codes: hit.codes };
}

/** Classifica i file nuovi o modificati e ricorda il risultato. */
export async function ensureClassificazioni(
  files: { name: string; full: string; size: number; mtimeMs: number }[]
): Promise<void> {
  const cache = await loadCache();
  let dirty = false;
  const seen = new Set<string>();
  for (const file of files) {
    seen.add(file.name);
    const hit = cache[file.name];
    const orderWithoutCodes = hit?.kind === "ordine" && !hit.codes;
    if (hit && hit.size === file.size && hit.mtime === file.mtimeMs && hit.kind && !orderWithoutCodes) {
      continue;
    }
    const meta = await classifyFile(file.full, file.name);
    cache[file.name] = { ...meta, size: file.size, mtime: file.mtimeMs };
    dirty = true;
  }
  for (const name of Object.keys(cache)) {
    if (!seen.has(name)) {
      delete cache[name];
      dirty = true;
    }
  }
  if (dirty) await saveCache(cache);
  else memory = cache;
}
