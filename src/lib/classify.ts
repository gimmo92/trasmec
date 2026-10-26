import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { getJson, putJson, useCloud } from "./cloud";
import { isJobCode, jobCode, jobCodeRegex } from "./jobcode";
import { parseMotorList, parseSensorList } from "./motorsensor";
import { extractPdfText, parseOrderText } from "./orderpdf";
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
  v?: number;
}

/** Va alzato quando cambiano le regole, così i file già visti vengono riclassificati. */
const CACHE_VERSION = 6;

const DATA_FILE = path.join(process.cwd(), "data", "classificazione.json");
const CLOUD_PATH = "config/classificazione.json";

let memory: Record<string, CacheEntry> | null = null;

/** Codici macchina dell'ordine: gli item dopo AFTER SALES. */
function orderCodes(text: string): string[] {
  return parseOrderText(text).includedItems.map((item) => item.code);
}

/** Motor list / sensor list anche quando il file è un PDF (`…-ML.pdf`). */
export function listKindFromName(name: string): "lista-motori" | "lista-sensori" | null {
  const n = name.toLowerCase();
  if (n.includes("-ml") || n.includes("motor list") || n.includes("lista motor")) return "lista-motori";
  if (n.includes("-sl") || n.includes("sensor list") || n.includes("lista sensor")) return "lista-sensori";
  return null;
}

/** Classificazione di riserva quando il contenuto non si lascia leggere. */
export function kindFromName(name: string): ClassifiedDoc {
  const n = name.toLowerCase();
  const code = jobCode(name);
  const listed = listKindFromName(name);
  if (listed) return { kind: listed };
  if (n.endsWith(".dwg")) return { kind: "disegno", code };
  if (n.endsWith(".pdf")) return code ? { kind: "disegno", code } : { kind: "altro" };
  if (n.includes("motor")) return { kind: "lista-motori" };
  if (n.includes("sensor")) return { kind: "lista-sensori" };
  if (n.includes("spare") || n.includes("listino") || n.includes("price")) return { kind: "listino" };
  if (/^b[a-z]\d{4}/i.test(name) || n.endsWith(".xlsm")) return { kind: "distinta", code };
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
  const codeInName = jobCode(name);

  const distintaSheet = names.find((sheet) =>
    /^(parts only|structured|bom index|distinta|distinta en)$/i.test(sheet.trim())
  );
  if (distintaSheet) {
    const codeSheet =
      names.find((sheet) => /^(bom index|1)$/i.test(sheet.trim())) ?? distintaSheet;
    const peeked = codeInName ? "" : peekSheet(filePath, codeSheet);
    return { kind: "distinta", code: codeInName ?? jobCode(peeked) };
  }

  if (lower.includes("ml")) return { kind: "lista-motori", code: codeInName };
  if (lower.includes("sl")) return { kind: "lista-sensori", code: codeInName };

  const sampleSheet =
    names.find((sheet) => sheet.trim() === "1") ??
    names.find((sheet) => !/^xl\/|macro/i.test(sheet)) ??
    names[0];
  const peeked = sampleSheet ? peekSheet(filePath, sampleSheet) : "";
  const blob = `${name}\n${names.join("\n")}\n${peeked}`.toLowerCase();
  const code = codeInName ?? jobCode(`${name}\n${peeked}`);
  const hasJob = jobCodeRegex("i").test(blob);

  if (/part number/.test(blob) && /description|qty|job nr|plate nr/.test(blob)) {
    return { kind: "distinta", code };
  }
  if (/job nr|plate nr|bom index/.test(blob) && hasJob) {
    return { kind: "distinta", code };
  }
  // Scheda di configurazione (foglio "1"): Job / Serial Number / Machine Code, senza "Parts only".
  if (lower.includes("1") && hasJob && /\bjob\b|serial number|machine code/.test(blob)) {
    return { kind: "distinta", code };
  }
  if (/\bcodice\b/.test(blob) && /disegno/.test(blob)) return { kind: "listino", code };
  if (lower.some((sheet) => /supporti|listino|spare/.test(sheet))) {
    return { kind: "listino", code };
  }
  return kindFromName(name);
}

async function classifyPdf(filePath: string, name: string): Promise<ClassifiedDoc> {
  const namedList = listKindFromName(name);
  if (namedList) return { kind: namedList };
  const text = (await extractPdfText(filePath)).slice(0, 40000);
  const codes = orderCodes(text);
  if (/AFTER\s*SALES/i.test(text) || /NR\.\s*DOCUMENTO/i.test(text)) {
    return { kind: "ordine", code: codes[0], codes };
  }
  if (/motor\s*list/i.test(text) && !/sensor\s*list/i.test(text)) return { kind: "lista-motori" };
  if (/sensor\s*list/i.test(text) && !/motor\s*list/i.test(text)) return { kind: "lista-sensori" };
  // Disegno: codice commessa nel titolo, senza le voci di un ordine.
  const titleCode = text.match(/(?:job\s*nr|numero\s*commessa)\.?\s*:?\s*(B[A-Z]\d{4})/i)?.[1];
  const drawingCode = jobCode(name) ?? titleCode?.toUpperCase();
  if (drawingCode && !/ORDER\s+CONFIRMATION/i.test(text)) {
    return { kind: "disegno", code: drawingCode };
  }
  if (codes.length && /COMMESSA|ORDINE|ORDER\s+CONFIRMATION/i.test(text)) {
    return { kind: "ordine", code: codes[0], codes };
  }
  if (/offerta\s+commerciale/i.test(text) || /template/i.test(name)) return { kind: "template" };
  return { kind: "altro" };
}

/** Commesse citate da una lista motori/sensori: servono per collegarla all'offerta. */
async function listCodes(filePath: string, kind: DocKind): Promise<string[]> {
  const rows = kind === "lista-motori" ? await parseMotorList(filePath) : await parseSensorList(filePath);
  return [...new Set(rows.map((row) => row.jobBase).filter(isJobCode))];
}

/** Guarda il contenuto, non solo il nome: distinta, ordine, listino, motori, sensori. */
export async function classifyFile(filePath: string, name: string): Promise<ClassifiedDoc> {
  const ext = path.extname(name).toLowerCase();
  let meta: ClassifiedDoc;
  try {
    if (ext === ".pdf") meta = await classifyPdf(filePath, name);
    else if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") meta = classifyExcel(filePath, name);
    else meta = kindFromName(name);
  } catch {
    meta = kindFromName(name);
  }
  if (meta.kind === "lista-motori" || meta.kind === "lista-sensori") {
    try {
      const codes = await listCodes(filePath, meta.kind);
      return { kind: meta.kind, code: codes[0], codes };
    } catch {
      return meta;
    }
  }
  return meta;
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
  if (!hit || hit.v !== CACHE_VERSION || hit.size !== size || hit.mtime !== mtimeMs) return null;
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
    const fresh = hit?.v === CACHE_VERSION && hit.size === file.size && hit.mtime === file.mtimeMs;
    if (hit && fresh && hit.kind) continue;
    const meta = await classifyFile(file.full, file.name);
    cache[file.name] = { ...meta, size: file.size, mtime: file.mtimeMs, v: CACHE_VERSION };
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
