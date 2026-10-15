import fs from "node:fs";
import { readWorkbookGrids, type Grid } from "./excel";

/** Voce dell'indice ricambi: codice vendibile + descrizione (dal listino). */
export interface SpareMapEntry {
  sellableCode: string;
  description?: string;
}

/** Mappa: codice distinta (DISEGNO / CODICE D.B.) -> codice vendibile. */
export type SpareCodeMap = Map<string, SpareMapEntry>;

// Cache in memoria (per path+mtime) per evitare di rileggere il file da 23MB.
let cache: { key: string; map: SpareCodeMap } | null = null;

function normHeader(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/['`.]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[:>]+$/g, "")
    .trim();
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// Etichette colonna "codice vendibile" (da usare nella proposta)
const SELLABLE_LABELS = new Set(["codice", "codice trasmec", "codice vendita", "code"]);
// Etichette colonna "codice distinta" (chiave di ricerca)
const BOM_KEY_LABELS_PRIMARY = new Set(["codice db", "codice d b"]);
const BOM_KEY_LABELS_SECONDARY = new Set(["disegno"]);

function findCol(headerRow: (string | number | null)[], labels: Set<string>): number {
  for (let c = 0; c < headerRow.length; c++) {
    if (labels.has(normHeader(headerRow[c]))) return c;
  }
  return -1;
}

/** Costruisce la mappa scandendo tutti i fogli del listino ricambi. */
function buildMap(grids: Record<string, Grid>): SpareCodeMap {
  const map: SpareCodeMap = new Map();

  for (const grid of Object.values(grids)) {
    let sellCol = -1;
    let keyCol = -1;

    for (const row of grid) {
      if (!row) continue;

      // È una riga di intestazione? (contiene una colonna codice vendibile + una chiave)
      const sTry = findCol(row, SELLABLE_LABELS);
      const kPrim = findCol(row, BOM_KEY_LABELS_PRIMARY);
      const kSec = findCol(row, BOM_KEY_LABELS_SECONDARY);
      if (sTry >= 0 && (kPrim >= 0 || kSec >= 0)) {
        sellCol = sTry;
        keyCol = kPrim >= 0 ? kPrim : kSec; // preferisci "CODICE D.B." a "DISEGNO"
        continue;
      }

      if (sellCol < 0 || keyCol < 0) continue;

      const key = cell(row[keyCol]).toUpperCase();
      const sell = cell(row[sellCol]);
      if (!key || !sell) continue;
      if (SELLABLE_LABELS.has(normHeader(sell))) continue; // riga header duplicata
      if (!map.has(key)) {
        map.set(key, { sellableCode: sell });
      }
    }
  }

  return map;
}

/** Restituisce (con cache) la mappa codice-distinta -> codice-vendibile. */
export function getSpareCodeMap(filePath: string): SpareCodeMap {
  let mtime = 0;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return new Map();
  }
  const key = `${filePath}:${mtime}`;
  if (cache && cache.key === key) return cache.map;

  const grids = readWorkbookGrids(filePath);
  const map = buildMap(grids);
  cache = { key, map };
  return map;
}
