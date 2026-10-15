import * as XLSX from "xlsx";
import type { BomHeader, BomRow, ParsedBom, ProposalLine, SheetSummary } from "./types";
import { listSigleCodes } from "./sigle";

export type Grid = (string | number | null)[][];

/** Legge un file Excel e restituisce, per ogni foglio, una griglia 2D di valori. */
export function readWorkbookGrids(filePath: string): Record<string, Grid> {
  const wb = XLSX.readFile(filePath, { cellDates: true, cellFormula: false });
  const grids: Record<string, Grid> = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    grids[name] = rows as Grid;
  }
  return grids;
}

/** Normalizza un testo cella per confronti (minuscolo, senza ":" finale, spazi compressi). */
function norm(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v).trim().toLowerCase();
  s = s.replace(/[:>]+$/g, "").trim();
  s = s.replace(/\s+/g, " ");
  return s;
}

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

/**
 * Cerca in una griglia una cella che corrisponda a una delle label indicate e
 * restituisce il valore associato.
 *
 * Nei moduli Trasmec il valore si trova quasi sempre nella cella SOTTO l'etichetta
 * (righe "etichetta / valore"), quindi si cerca prima sotto e poi a destra.
 * `labelSet` (facoltativo) contiene tutte le etichette note: una cella candidata
 * che coincide con un'altra etichetta viene scartata (non è un valore).
 */
export function findLabelValue(
  grid: Grid,
  labels: string[],
  labelSet?: Set<string>
): string | undefined {
  const targets = labels.map(norm);
  const isLabel = (v: unknown) => (labelSet ? labelSet.has(norm(v)) : false);

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const cell = norm(row[c]);
      if (!cell || !targets.includes(cell)) continue;

      // 1) sotto, stessa colonna (pattern dominante etichetta/valore)
      for (let rr = r + 1; rr < Math.min(grid.length, r + 3); rr++) {
        const below = grid[rr]?.[c];
        if (!isEmpty(below) && !isLabel(below)) return cellStr(below);
      }
      // 2) a destra, stessa riga
      for (let cc = c + 1; cc < row.length; cc++) {
        if (isEmpty(row[cc])) continue;
        if (isLabel(row[cc])) break; // colonna successiva è un'altra etichetta
        return cellStr(row[cc]);
      }
    }
  }
  return undefined;
}

/** Trova l'indice della colonna il cui header combacia con una delle etichette. */
function findColIndex(headerRow: (string | number | null)[], labels: string[]): number {
  const targets = labels.map(norm);
  for (let c = 0; c < headerRow.length; c++) {
    const cell = norm(headerRow[c]);
    if (targets.includes(cell)) return c;
  }
  // match parziale
  for (let c = 0; c < headerRow.length; c++) {
    const cell = norm(headerRow[c]);
    if (cell && targets.some((t) => cell.includes(t))) return c;
  }
  return -1;
}

/** Converte un valore in numero, gestendo la virgola decimale. */
export function parseNum(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/\s/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Legge la tabella BOM da un foglio con header tipo "Item | Part Number | ... | QTY". */
function readBomTable(grid: Grid): { rows: BomRow[]; warnings: string[] } {
  const warnings: string[] = [];
  // Trova la riga di header (contiene "Part Number" e "DESCRIPTION")
  let headerIdx = -1;
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const row = grid[r] ?? [];
    const joined = row.map(norm);
    if (joined.includes("part number") && joined.some((x) => x.startsWith("description"))) {
      headerIdx = r;
      break;
    }
  }
  if (headerIdx === -1) {
    warnings.push("Riga di intestazione BOM non trovata (colonna 'Part Number').");
    return { rows: [], warnings };
  }
  const header = grid[headerIdx] ?? [];
  const cols = {
    item: findColIndex(header, ["item"]),
    partNumber: findColIndex(header, ["part number"]),
    rev: findColIndex(header, ["rev"]),
    descriptionEN: findColIndex(header, ["description en", "description"]),
    descriptionIT: findColIndex(header, ["descrizione", "description"]),
    qty: findColIndex(header, ["qty", "q.ty", "quantity"]),
    mass: findColIndex(header, ["mass", "massa"]),
    sparePart: findColIndex(header, ["spare part", "spare"]),
    objectType: findColIndex(header, ["object type", "type"]),
    thickness: findColIndex(header, ["thk", "thickness", "spessore"]),
    material: findColIndex(header, ["material", "materiale"]),
  };

  const rows: BomRow[] = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const item = cols.item >= 0 ? cellStr(row[cols.item]) : "";
    const pn = cols.partNumber >= 0 ? cellStr(row[cols.partNumber]) : "";
    if (!item && !pn) continue; // salta righe vuote
    const qtyRaw = cols.qty >= 0 ? row[cols.qty] : undefined;
    const qty =
      typeof qtyRaw === "number" ? qtyRaw : qtyRaw != null ? cellStr(qtyRaw) : undefined;
    rows.push({
      item: item || undefined,
      partNumber: pn || undefined,
      rev: cols.rev >= 0 ? cellStr(row[cols.rev]) || undefined : undefined,
      descriptionEN:
        cols.descriptionEN >= 0 ? cellStr(row[cols.descriptionEN]) || undefined : undefined,
      descriptionIT:
        cols.descriptionIT >= 0 && cols.descriptionIT !== cols.descriptionEN
          ? cellStr(row[cols.descriptionIT]) || undefined
          : undefined,
      qty,
      mass: cols.mass >= 0 ? cellStr(row[cols.mass]) || undefined : undefined,
      sparePart: cols.sparePart >= 0 ? cellStr(row[cols.sparePart]) || undefined : undefined,
      objectType: cols.objectType >= 0 ? cellStr(row[cols.objectType]) || undefined : undefined,
      thickness: cols.thickness >= 0 ? cellStr(row[cols.thickness]) || undefined : undefined,
      material: cols.material >= 0 ? cellStr(row[cols.material]) || undefined : undefined,
    });
  }
  return { rows, warnings };
}

function isBlankType(v: string | undefined): boolean {
  const s = (v ?? "").trim();
  return !s || s === "-" || s === "–";
}

/**
 * Distinta base TKK (foglio "1"): non c'è la tabella Part Number.
 * Estrae i ricambi dalle sezioni etichettate: sopporti, catena, sprinkler, pale.
 */
export function extractConfigBom(grids: Record<string, Grid>): {
  rows: BomRow[];
  warnings: string[];
  sheetUsed?: string;
} {
  const grid = grids["1"];
  if (!grid?.length) {
    return { rows: [], warnings: ["Foglio '1' della distinta base TKK non trovato."] };
  }

  const rows: BomRow[] = [];
  const warnings: string[] = [];
  let machineId = "";
  let machineStd = "";
  let seenConveyingChain = false;
  let seenSprinklers = false;
  let chainMeters = 0;
  let chainLinks = 0;

  const push = (row: BomRow) => {
    rows.push({ ...row, source: "config" });
  };

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const label = cellStr(row[1]);
    const labelN = label.toLowerCase();

    if (labelN === "id") {
      const next = grid[r + 1] ?? [];
      const stdCol = row.findIndex((c) => norm(c) === "standard");
      const id = cellStr(next[1]);
      const std = stdCol >= 0 ? cellStr(next[stdCol]) : "";
      if (id && id !== "-") machineId = id;
      if (std && std !== "-") machineStd = std;
    }

    if (labelN === "conveying chain") {
      seenConveyingChain = true;
      continue;
    }

    if (seenConveyingChain) {
      const code = cellStr(row[3]);
      const meters = parseNum(row[2]);
      // Codice assieme: CT#### (TKK) oppure numero disegno 012.25.04.12.02.13 (TK)
      const isAssembly = /^CT\d+/i.test(code) || /^\d{3}(\.\d{2}){5}$/.test(code);
      if (isAssembly && meters && meters > 0) {
        const link = [cellStr(row[5]), cellStr(row[6])].filter(Boolean).join(" ");
        const pin = cellStr(row[7]);
        chainMeters = meters;
        chainLinks = parseNum(row[11]) ?? 0;
        push({
          partNumber: code,
          descriptionEN: `TRASPORT CHAIN ${link} ${pin}`.replace(/\s+/g, " ").trim(),
          qty: meters,
          um: "MT",
        });
        seenConveyingChain = false;
      }
    }

    if (labelN === "bearing assembly") {
      const leftQty = parseNum(row[3]);
      const leftType = cellStr(row[4]);
      const rightQty = parseNum(row[9]);
      const rightType = cellStr(row[10]);
      const addSupport = (type: string, qty: number | undefined) => {
        if (isBlankType(type) || !qty) return;
        const d = type.match(/^D(\d+)$/i);
        const desc = d
          ? `Bearing Assembly ${type} Support TKK Ø=${d[1]}`
          : `Bearing Assembly ${type} Support`;
        push({
          partNumber: type,
          descriptionEN: desc,
          qty,
          um: "NR",
        });
      };
      addSupport(leftType, leftQty);
      addSupport(rightType, rightQty);
    }

    if (labelN === "sprinklers") {
      seenSprinklers = true;
      continue;
    }
    if (seenSprinklers) {
      const qty = parseNum(row[1]);
      const type = cellStr(row[2]);
      if (qty && qty > 0 && !isBlankType(type) && !/^tot/i.test(type)) {
        push({
          partNumber: type,
          descriptionEN: `Sprinkler ${type}`,
          qty,
          um: "NR",
        });
        seenSprinklers = false;
      } else if (labelN === "sprinkler holders" || labelN === "sprinkler plates") {
        seenSprinklers = false;
      }
    }
  }

  const pala = palaMaterialFromCodici(grids["Codici"], machineId, machineStd);
  const hasPala = pala ? pala.toUpperCase() !== "NO" : chainMeters > 0 || chainLinks > 0;
  if (hasPala && (chainMeters > 0 || chainLinks > 0)) {
    const qty =
      chainLinks > 0 ? Math.ceil(chainLinks / 20) : Math.ceil(chainMeters / 1.42);
    push({
      partNumber: "CT0003",
      descriptionEN: pala ? `Scraper pala ${pala}` : "Scraper",
      qty,
      um: "NR",
    });
  }

  if (!rows.length) {
    warnings.push(
      "Distinta base TKK: nessun supporto, catena, sprinkler o scraper individuato nel foglio '1'."
    );
  }

  return { rows, warnings, sheetUsed: "1" };
}

/** Colonna "pale" del foglio Codici, allineata a ID macchina + esecuzione (es. TKKB79 / E01). */
function palaMaterialFromCodici(
  grid: Grid | undefined,
  machineId: string,
  machineStd: string
): string | undefined {
  if (!grid?.length || !machineId) return undefined;
  let headerIdx = -1;
  let colId = -1;
  let colEsec = -1;
  let colPale = -1;
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const row = grid[r] ?? [];
    const labels = row.map((c) => norm(c));
    const id = labels.findIndex((x) => x === "id");
    const pale = labels.findIndex((x) => x === "pale" || x === "pala");
    if (id >= 0 && pale >= 0) {
      headerIdx = r;
      colId = id;
      colPale = pale;
      colEsec = labels.findIndex((x) => x === "esec" || x === "standard");
      break;
    }
  }
  if (headerIdx < 0) return undefined;
  const idWant = machineId.toUpperCase();
  const stdWant = machineStd.replace(/\s+/g, "").toUpperCase();
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (cellStr(row[colId]).toUpperCase() !== idWant) continue;
    if (colEsec >= 0 && stdWant) {
      const esec = cellStr(row[colEsec]).replace(/\s+/g, "").toUpperCase();
      if (esec && esec !== stdWant) continue;
    }
    const pale = cellStr(row[colPale]);
    if (pale) return pale;
  }
  return undefined;
}

/** True se il part number inizia con una sigla della tab Sigle spare parts (filtro 1). */
export function isSparePartCode(partNumber: string | undefined): boolean {
  if (!partNumber) return false;
  const p = partNumber.trim().toUpperCase();
  return listSigleCodes().some((s) => s.length > 0 && p.startsWith(s));
}

/** Scorta consigliata = 10% dell'installato, arrotondato per eccesso (min 1 se installato>0). */
export function recommendedFromInstalled(installed: number): number {
  if (!installed || installed <= 0) return 0;
  return Math.max(1, Math.ceil(installed * 0.1));
}

/**
 * Estrae i ricambi da una distinta: usa il foglio "Parts only" se presente,
 * altrimenti "Structured". Filtra le righe per prefisso del part number.
 */
export function extractSpareParts(grids: Record<string, Grid>): {
  lines: ProposalLine[];
  warnings: string[];
  sheetUsed?: string;
} {
  const sheetName = grids["Parts only"]
    ? "Parts only"
    : grids["Structured"]
      ? "Structured"
      : undefined;

  if (!sheetName) {
    return {
      lines: [],
      warnings: [
        "Nessun foglio 'Parts only'/'Structured': ricambi non estraibili da questa distinta (formato scheda di configurazione).",
      ],
    };
  }

  const { rows, warnings } = readBomTable(grids[sheetName]);
  const lines: ProposalLine[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const pn = (row.partNumber ?? "").trim();
    if (!isSparePartCode(pn)) continue;
    if (seen.has(pn)) {
      // stesso codice più volte: somma le quantità
      const existing = lines.find((l) => l.code === pn);
      if (existing) {
        const add = parseNum(row.qty) ?? 0;
        existing.installedQty += add;
        existing.recommendedQty = recommendedFromInstalled(existing.installedQty);
      }
      continue;
    }
    seen.add(pn);
    const installed = parseNum(row.qty) ?? 0;
    lines.push({
      code: pn,
      descriptionEN: row.descriptionEN,
      descriptionIT: row.descriptionIT,
      installedQty: installed,
      recommendedQty: recommendedFromInstalled(installed),
      um: "NR",
      category: "spare",
      material: row.material,
      mass: row.mass,
    });
  }

  return { lines, warnings, sheetUsed: sheetName };
}

/** Mappa campo intestazione -> possibili etichette nei fogli Excel. */
const HEADER_LABELS: Record<keyof BomHeader & string, string[]> = {
  jobNr: ["job nr.", "job nr", "job"],
  serialNumber: ["plate nr.", "plate nr", "serial number", "matricola"],
  machineCode: ["drawing nr.", "machine code", "drawing", "sale"],
  conveyorCategory: ["conveyor category"],
  sizeType: ["size & type", "size type"],
  customer: ["customer", "cliente"],
  finalCustomer: ["final customer"],
  plant: ["plant", "impianto"],
  orderConfirmation: [
    "order confirmation nr.",
    "internal order confirmation",
    "internal order conf nr",
  ],
  customerOrder: ["customer order"],
  projectNr: ["project nr. / trt", "project nr.", "record file", "project nr"],
  layoutPosition: ["layout position", "layout pos.", "layout pos"],
  atexConfig: ["atex configuration", "arrangement", "atex"],
  year: ["manufacturing y.", "mfg. year", "anno fabbr.", "year"],
  dateReleased: ["date released", "issue date", "data documento"],
};

/** Estrae l'intestazione (dati generali) provando le due varianti di layout. */
function extractHeader(grids: Record<string, Grid>): BomHeader {
  // Unisce tutti i fogli candidati per la ricerca label->valore
  const candidateSheets = ["BOM Index", "1", "Structured", "Foglio1"];
  const searchGrids: Grid[] = [];
  for (const s of candidateSheets) {
    if (grids[s]) searchGrids.push(grids[s]);
  }
  if (searchGrids.length === 0) searchGrids.push(...Object.values(grids));

  // Insieme di tutte le etichette note: serve per scartare i candidati che
  // sono in realtà un'altra etichetta e non un valore.
  const labelSet = new Set<string>();
  for (const labels of Object.values(HEADER_LABELS)) {
    for (const l of labels) labelSet.add(l);
  }

  const find = (labels: string[]): string | undefined => {
    for (const g of searchGrids) {
      const v = findLabelValue(g, labels, labelSet);
      if (v) return v;
    }
    return undefined;
  };

  const header: BomHeader = {};
  for (const [field, labels] of Object.entries(HEADER_LABELS)) {
    header[field] = find(labels);
  }
  return header;
}

/** Parsa un file di distinta base in una struttura normalizzata. */
export function parseBom(filePath: string, relPath: string): ParsedBom {
  const grids = readWorkbookGrids(filePath);
  const sheetNames = Object.keys(grids);
  const sheets: SheetSummary[] = sheetNames.map((name) => {
    const g = grids[name] ?? [];
    const cols = g.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
    return { name, rows: g.length, cols };
  });

  const warnings: string[] = [];
  let format: ParsedBom["format"] = "unknown";
  let bom: BomRow[] = [];

  if (grids["Structured"]) {
    format = "structured";
    const res = readBomTable(grids["Structured"]);
    bom = res.rows;
    warnings.push(...res.warnings);
  } else if (grids["1"]) {
    format = "config";
    const res = extractConfigBom(grids);
    bom = res.rows;
    warnings.push(...res.warnings);
  } else {
    warnings.push("Formato distinta non riconosciuto: nessun foglio 'Structured' o '1'.");
  }

  const header = extractHeader(grids);

  return {
    file: filePath.split(/[\\/]/).pop() ?? filePath,
    path: relPath,
    format,
    sheets,
    header,
    bom,
    warnings,
  };
}

/** Estrae, in un'unica lettura, intestazione + tutte le righe BOM (per l'offerta). */
export function parseBomForOffer(
  filePath: string,
  relPath: string
): {
  file: string;
  format: ParsedBom["format"];
  header: BomHeader;
  bom: BomRow[];
  warnings: string[];
} {
  const grids = readWorkbookGrids(filePath);
  const header = extractHeader(grids);
  const format: ParsedBom["format"] = grids["Structured"]
    ? "structured"
    : grids["1"]
      ? "config"
      : "unknown";
  const { rows, warnings } = extractAllBomRows(grids);
  return {
    file: filePath.split(/[\\/]/).pop() ?? filePath,
    format,
    header,
    bom: rows,
    warnings,
  };
}

/**
 * Tutte le righe della distinta (Parts only / Structured / primo foglio con Part Number).
 * Nessun filtro per prefisso: il filtro ricambi è demandato agli indici.
 */
export function extractAllBomRows(grids: Record<string, Grid>): {
  rows: BomRow[];
  warnings: string[];
  sheetUsed?: string;
} {
  const preferred = ["Parts only", "Structured"];
  for (const name of preferred) {
    if (!grids[name]) continue;
    const res = readBomTable(grids[name]);
    if (res.rows.length) return { ...res, sheetUsed: name };
  }
  if (grids["1"] && !grids["Structured"] && !grids["Parts only"]) {
    return extractConfigBom(grids);
  }
  for (const [name, grid] of Object.entries(grids)) {
    if (preferred.includes(name)) continue;
    const res = readBomTable(grid);
    if (res.rows.length) return { ...res, sheetUsed: name };
  }
  if (grids["1"]) return extractConfigBom(grids);
  return {
    rows: [],
    warnings: [
      "Nessun foglio con tabella 'Part Number': ricambi non estraibili da questa distinta.",
    ],
  };
}
