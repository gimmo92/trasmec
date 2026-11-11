import * as XLSX from "xlsx";
import type { BomHeader, BomRow, ParsedBom, ProposalLine, SheetSummary } from "./types";
import { listSigleCodes } from "./sigle";

export type Grid = (string | number | null)[][];

interface WorkbookRead {
  grids: Record<string, Grid>;
  /** Distinte xlsm: nome macchina in D4 della prima pagina (foglio BOM Index). */
  bomIndexD4?: string;
}

function readWorkbook(filePath: string): WorkbookRead {
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
  const indexName = wb.SheetNames.find((n) => /^bom\s*index$/i.test(n.trim()));
  const d4 = indexName ? cellStr(wb.Sheets[indexName]?.["D4"]?.v) : "";
  return { grids, bomIndexD4: plausibleMachineName(d4) ? d4 : undefined };
}

/** Legge un file Excel e restituisce, per ogni foglio, una griglia 2D di valori. */
export function readWorkbookGrids(filePath: string): Record<string, Grid> {
  return readWorkbook(filePath).grids;
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
  nameMinimaxSprinklers(rows);
  return { rows, warnings };
}

/** «Sprinkler minimax» senza modello MXD è lo sprinkler MXD-STD-ELM-K40. */
function nameMinimaxSprinklers(rows: BomRow[]): void {
  for (const row of rows) {
    const text = `${row.partNumber ?? ""} ${row.descriptionEN ?? ""} ${row.descriptionIT ?? ""}`;
    if (!/minimax/i.test(text) || /MXD-/i.test(text)) continue;
    const named = sprinklerOfferName(text);
    if (!named) continue;
    row.partNumber = named.code;
    row.descriptionEN = named.description;
    if (row.descriptionIT && /minimax/i.test(String(row.descriptionIT)) && !/MXD-/i.test(String(row.descriptionIT))) {
      row.descriptionIT = undefined;
    }
  }
}

function isBlankType(v: string | undefined): boolean {
  const s = (v ?? "").trim();
  return !s || s === "-" || s === "–";
}

/**
 * Ugello Minimax. In distinta il modello è MXD-SDT-ELM-K40 (TKK) oppure
 * MXD-STD-ELM-K40 (TK): in offerta è lo stesso codice, UGELLO-MXD-SDTELMK40.
 * La descrizione resta "Sprinkler" più il modello scritto in distinta.
 * «Sprinkler minimax» senza modello è MXD-STD-ELM-K40.
 */
export function sprinklerOfferName(raw: string): { code: string; description: string } | null {
  const source = raw.replace(/\s+/g, " ").trim();
  let model = source
    .replace(/^sprinklers?\s*[-–]?\s*/i, "")
    .replace(/\s*minimax\s*/gi, " ")
    .trim();
  if (!model || !/\d/.test(model)) {
    if (!/minimax/i.test(source)) return null;
    model = "MXD-STD-ELM-K40";
  }
  let compact = model.toUpperCase();
  compact = compact.replace(/^MXD-STD-ELM-K40$/, "MXD-SDT-ELM-K40");
  const parts = compact.split(/[-\s]+/).filter(Boolean);
  const code =
    parts.length <= 1
      ? `UGELLO-${parts[0] || compact}`
      : `UGELLO-${parts[0]}-${parts.slice(1).join("")}`;
  return { code, description: `Sprinkler ${model.toUpperCase()}` };
}

/** 620x820, 300 x 620 o 620×820 → 620X820. I bulloni (M10x25) non sono una misura di portella. */
function doorMeasure(raw: string): string {
  const found = raw.toUpperCase().match(/(\d+)\s*[X×]\s*(\d+)/);
  if (!found) return "";
  if (Number(found[1]) < 100 || Number(found[2]) < 100) return "";
  return `${found[1]}X${found[2]}`;
}

function pushExplosionDoor(
  push: (row: BomRow) => void,
  code: string,
  size: string,
  qty: number | undefined
) {
  if (!qty || qty <= 0) return;
  const measure = doorMeasure(size) || doorMeasure(code);
  if (!measure && isBlankType(code)) return;
  const shown = measure || (!isBlankType(size) && size !== code ? size : "");
  push({
    partNumber: measure ? `PEX-EXGO-${measure}` : code,
    descriptionEN: `Explosion proof door PORTELL${shown ? ` ${shown}` : ""}`.replace(/\s+/g, " ").trim(),
    qty,
    um: "NR",
  });
}

/**
 * Pannelli di scoppio (explosion proof door). Il telaio non entra.
 * TK: Standard/Domed sulla stessa riga (Qty, Size, Item). TKK: una sezione sotto l'altra.
 */
function addBurstingDoors(grid: Grid, push: (row: BomRow) => void) {
  let inBurst = false;
  let kind = "";
  const panelKind = /^(standard|domed|flameless|q-?box)$/i;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const label = cellStr(row[1]).toLowerCase();
    if (label === "bursting panels") {
      inBurst = true;
      kind = "";
      continue;
    }
    if (!inBurst) continue;
    if (label === "inspection window for curved trough" || label === "remarks") break;
    if (panelKind.test(label)) {
      kind = label.replace("-", "");
      continue;
    }
    if (label === "frame" || label === "cover") {
      kind = "frame";
      continue;
    }
    if (label === "qty" && /size/i.test(cellStr(row[2]))) {
      const data = grid[r + 1] ?? [];
      pushExplosionDoor(push, cellStr(data[3]), cellStr(data[2]), parseNum(data[1]));
      const rightItem = cellStr(data[6]);
      const rightMid = cellStr(data[5]);
      pushExplosionDoor(
        push,
        !isBlankType(rightItem) ? rightItem : rightMid,
        !isBlankType(rightItem) ? rightMid : "",
        parseNum(data[4])
      );
      kind = "";
      r += 1;
      continue;
    }
    if (label === "qty" || !kind || kind === "frame") continue;
    const qty = parseNum(row[1]);
    if (qty === undefined) continue;
    const second = cellStr(row[2]);
    const third = cellStr(row[3]);
    const code = !isBlankType(third) ? third : second;
    const size = !isBlankType(third) ? second : "";
    pushExplosionDoor(push, code, size, qty);
    kind = "";
  }
}

/**
 * Distinta base TKK (foglio "1"): non c'è la tabella Part Number.
 * Estrae i ricambi dalle sezioni etichettate: supporti, catena, settori,
 * sprinkler, explosion proof door e, solo sulla catena doppia, gli scraper.
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
  let sawSingleChain = false;
  let sawDoubleChain = false;

  const push = (row: BomRow) => {
    rows.push({ ...row, source: "config" });
  };

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const label = cellStr(row[1]);
    const labelN = label.toLowerCase();
    if (/single\s*chain/i.test(labelN)) sawSingleChain = true;
    if (/double\s*chain/i.test(labelN)) sawDoubleChain = true;

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
        if (/^CT\d/i.test(code) && !sawSingleChain) sawDoubleChain = true;
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
        const named = sprinklerOfferName(type);
        push({
          partNumber: named?.code || type,
          descriptionEN: named?.description || `Sprinkler ${type}`,
          qty,
          um: "NR",
        });
        seenSprinklers = false;
      } else if (labelN === "sprinkler holders" || labelN === "sprinkler plates") {
        seenSprinklers = false;
      }
    }
  }

  addBurstingDoors(grid, push);
  addToothedSectors(grid, push, warnings);

  const pala = palaMaterialFromCodici(grids["Codici"], machineId, machineStd);
  const hasPala = pala ? pala.toUpperCase() !== "NO" : chainMeters > 0 || chainLinks > 0;
  const doubleChain = sawDoubleChain && !sawSingleChain;
  if (doubleChain && hasPala && (chainMeters > 0 || chainLinks > 0)) {
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

/** Passo catena dal tipo, per esempio 14226 MN → 142. Serve al codice del settore. */
function configChainPitch(grid: Grid): string {
  for (let r = 0; r < grid.length; r++) {
    if (cellStr(grid[r]?.[1]).toLowerCase() !== "conveying chain") continue;
    for (let k = r + 1; k < Math.min(grid.length, r + 8); k++) {
      const type = cellStr(grid[k]?.[5]);
      const size = type.match(/\b(\d{3})\d{2,}\b/);
      if (size) return size[1];
    }
  }
  return "";
}

/**
 * Settori dentati del riquadro Hubs for Sectors (teste motrice e di rinvio).
 * Il codice listino è SECTOR-Z10-P142: denti della colonna z, passo della catena.
 */
function addToothedSectors(
  grid: Grid,
  push: (row: BomRow) => void,
  warnings: string[]
) {
  const pitch = configChainPitch(grid);
  for (let r = 0; r < grid.length; r++) {
    const header = (grid[r] ?? []).map((cell) => norm(cell));
    const toothCol = header.findIndex((cell) => cell === "toothed sectors");
    if (toothCol < 0) continue;
    const fields = grid[r + 1] ?? [];
    const zCol = fields.findIndex((cell, index) => index >= toothCol && norm(cell) === "z");
    if (zCol < 0) {
      warnings.push("Settori: nel riquadro Hubs for Sectors manca la colonna z.");
      continue;
    }
    for (let k = r + 2; k < Math.min(grid.length, r + 8); k++) {
      const data = grid[k] ?? [];
      const name = cellStr(data[1]);
      if (/bearing assemblies|fasteners|sprinkler/i.test(name)) break;
      const qty = parseNum(data[toothCol]);
      const teeth = cellStr(data[zCol]).replace(/^z\s*=?\s*/i, "");
      if (!qty || qty <= 0 || !/^\d+$/.test(teeth)) continue;
      const z = teeth.padStart(2, "0");
      if (!pitch) {
        warnings.push(`Settori z=${z}: passo catena non trovato, codice listino non assegnato.`);
        push({
          partNumber: `SECTOR-Z${z}`,
          descriptionEN: `Toothed SECTOR Z=${z}`,
          qty,
          um: "NR",
        });
        continue;
      }
      push({
        partNumber: `SECTOR-Z${z}-P${pitch}`,
        descriptionEN: `Toothed SECTOR Z=${z} P=${pitch}`,
        qty,
        um: "NR",
      });
    }
  }
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

const MACHINE_WORD =
  /macchin|machine|maschine|maquin|maszyn|makine|maskin|mashin/;
const TYPE_WORD = /(?:^|[^a-z])(?:tipo|type|typ|tipi|tip)(?:[^a-z]|$)|typ$/;

const BARE_TYPE = /^(tipo|type|typ|tipi|tip)$/;

function foldLabel(v: unknown): string {
  return norm(v).normalize("NFD").replace(/\p{M}/gu, "");
}

/**
 * Etichetta «tipo macchina» in qualunque lingua (Machine type, Maschinentyp, …).
 * Sulla targa a volte c'è solo «TYPE»: vale solo se allowBare è true.
 */
function isMachineTypeLabel(v: unknown, allowBare = false): boolean {
  const s = foldLabel(v);
  if (!s || s.length > 40) return false;
  if (/\b(code|codice|serial|matricol|disegno|drawing|year|anno)\b/.test(s)) return false;
  if (MACHINE_WORD.test(s) && TYPE_WORD.test(s)) return true;
  return allowBare && BARE_TYPE.test(s);
}

function plausibleMachineName(v: string): boolean {
  const s = v.trim();
  if (s.length < 2 || s.length > 80) return false;
  if (/^\d{4}$/.test(s)) return false;
  if (/^B[A-Z]\d{4}/i.test(s)) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (isMachineTypeLabel(s) || BARE_TYPE.test(foldLabel(s))) return false;
  return true;
}

/**
 * Nome macchina sulla targa: cella a fianco di «tipo macchina».
 * Prima la seconda pagina e i fogli targa/etichetta, poi gli altri.
 */
function isDictionarySheet(name: string): boolean {
  return /dizion|dictionary|traduz|translation|glossar/i.test(name);
}

function findPlateMachineType(grids: Record<string, Grid>): string | undefined {
  const names = Object.keys(grids).filter((name) => !isDictionarySheet(name));
  const ranked = names
    .map((name, index) => ({ name, index }))
    .sort((a, b) => plateSheetRank(a.name, a.index) - plateSheetRank(b.name, b.index));

  for (const { name } of ranked) {
    const allowBare = /label|targa|targhetta|data\s*plate|\bplate\b/i.test(name);
    const grid = grids[name] ?? [];
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        if (!isMachineTypeLabel(row[c], allowBare)) continue;
        for (let cc = c + 1; cc < row.length; cc++) {
          if (isEmpty(row[cc])) continue;
          const value = cellStr(row[cc]);
          if (!plausibleMachineName(value)) break;
          return value;
        }
      }
    }
  }
  return undefined;
}

function plateSheetRank(name: string, index: number): number {
  if (index === 1 || name.trim() === "2") return 0;
  if (/label|targa|targhetta|data\s*plate|\bplate\b/i.test(name)) return 1;
  return 2;
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
function extractHeader(grids: Record<string, Grid>, bomIndexD4?: string): BomHeader {
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
  header.plateType = bomIndexD4 || findPlateMachineType(grids);
  return header;
}

/** TC, TK e TKK: la catena resta in offerta anche senza metri scritti in distinta. */
function isChainConveyor(header: BomHeader, grids: Record<string, Grid>): boolean {
  const bits: string[] = [
    header.conveyorCategory,
    header.plateType,
    header.sizeType,
    header.machineCode,
    header.description,
  ].filter((s): s is string => Boolean(s));
  const config = grids["1"];
  if (config) {
    for (let r = 0; r < Math.min(config.length, 8); r++) {
      const label = (config[r] ?? []).slice(0, 6).map((c) => cellStr(c)).filter(Boolean).join(" ");
      if (label) bits.push(label);
    }
  }
  return /(?:^|[^A-Z0-9])(?:TKK|TC|TK)(?![A-Z])/i.test(bits.join(" "));
}

/** Catena di trasporto o trasmissione. Giunto, guida e supporto non lo sono. */
function isTransportChainRow(row: BomRow): boolean {
  const pn = (row.partNumber ?? "").trim();
  const en = (row.descriptionEN ?? "").trim();
  const it = (row.descriptionIT ?? "").trim();
  const text = `${pn} ${en} ${it}`;
  if (
    /coupling|giunto|coprigiunto|coverjoint|support|sostegn|guida|\bguide\b|holder|scraper|\bpala\b|carter/i.test(
      text
    )
  ) {
    return false;
  }
  if (/^CHAIN$/i.test(pn)) return true;
  if (/^chain\b/i.test(en) || /^catena\b/i.test(en) || /^catena\b/i.test(it)) return true;
  return /\b(trasport|conveying|transmission)\b/i.test(text) && /\b(chain|catena)\b/i.test(text);
}

/** L=3,4925 oppure una misura in m/mt/mm. L=- non è una lunghezza. */
function textHasChainLength(text: string): boolean {
  for (const m of text.matchAll(/L\s*=\s*([0-9]+(?:[.,][0-9]+)?)/gi)) {
    const n = Number(m[1].replace(",", "."));
    if (n > 0) return true;
  }
  for (const m of text.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(mm|mt|m)\b/gi)) {
    const n = Number(m[1].replace(",", "."));
    const unit = m[2].toLowerCase();
    if (!n || n <= 0) continue;
    if (unit === "mm" && n < 100) continue;
    return true;
  }
  return false;
}

/** Metri della sezione Chain in distinta (L (m) installata o di scorta). */
function distintaChainMeters(grids: Record<string, Grid>): number {
  let best = 0;
  for (const grid of Object.values(grids)) {
    for (let r = 0; r < grid.length; r++) {
      const lCols: number[] = [];
      (grid[r] ?? []).forEach((cell, i) => {
        const label = norm(cell);
        if (label === "l (m)" || label === "l(m)") lCols.push(i);
      });
      if (!lCols.length) continue;
      for (let h = r + 1; h < Math.min(grid.length, r + 8); h++) {
        const data = grid[h] ?? [];
        const name = cellStr(data[1]) || cellStr(data[0]);
        if (!name) continue;
        if (!/^chain$/i.test(name)) break;
        for (const col of lCols) {
          const n = parseNum(data[col]);
          if (n && n > 0) best = Math.max(best, n);
        }
      }
    }
  }
  return best;
}

function rowHasChainLength(row: BomRow, distintaMeters: number): boolean {
  if (distintaMeters > 0) return true;
  const text = `${row.descriptionEN ?? ""} ${row.descriptionIT ?? ""}`;
  if (textHasChainLength(text)) return true;
  if (/L\s*=\s*(?:-|–)?(?!\d)/i.test(text)) return false;
  const qty = parseNum(row.qty);
  const um = String(row.um ?? "").trim();
  if (/^(m|mt|mm)$/i.test(um) && qty && qty > 0) return true;
  return textHasChainLength(String(row.qty ?? ""));
}

/**
 * Fuori da TC, TK e TKK la catena entra solo se la distinta ha la lunghezza.
 * Senza metri, «Chain - L=-» non diventa una riga di offerta.
 */
function withoutChainsMissingLength(
  rows: BomRow[],
  header: BomHeader,
  grids: Record<string, Grid>,
  warnings: string[]
): BomRow[] {
  if (isChainConveyor(header, grids)) return rows;
  const meters = distintaChainMeters(grids);
  let dropped = false;
  const kept = rows.filter((row) => {
    if (!row.partNumber) return true;
    if (!isTransportChainRow(row) || rowHasChainLength(row, meters)) return true;
    dropped = true;
    return false;
  });
  if (dropped) {
    warnings.push(
      "Catena non inserita: la macchina non è TC, TK o TKK e in distinta non c'è la lunghezza."
    );
  }
  return kept;
}

/** Parsa un file di distinta base in una struttura normalizzata. */
export function parseBom(filePath: string, relPath: string): ParsedBom {
  const { grids, bomIndexD4 } = readWorkbook(filePath);
  const sheetNames = Object.keys(grids);
  const sheets: SheetSummary[] = sheetNames.map((name) => {
    const g = grids[name] ?? [];
    const cols = g.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
    return { name, rows: g.length, cols };
  });

  const warnings: string[] = [];
  let format: ParsedBom["format"] = "unknown";
  let bom: BomRow[] = [];

  const scheda =
    !grids["Structured"] && !grids["1"] ? extractSchedaBom(grids) : null;
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
  } else if (scheda) {
    format = "unknown";
    bom = scheda.rows;
    warnings.push(...scheda.warnings);
  } else {
    warnings.push("Formato distinta non riconosciuto: nessun foglio 'Structured' o '1'.");
  }

  const header = extractHeader(grids, bomIndexD4);
  bom = withoutChainsMissingLength(bom, header, grids, warnings);

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

/**
 * Coclea: il cuscinetto di CU1047 può stare in un altro foglio della commessa
 * (distinta), non sulla riga del supporto. Queste righe non hanno part number,
 * quindi non diventano ricambi: servono solo a scegliere CUS-22217K o CUS-21314.
 */
function appendBearingHints(grids: Record<string, Grid>, rows: BomRow[]): void {
  const seen = new Set<string>();
  for (const grid of Object.values(grids)) {
    for (const drow of grid ?? []) {
      const text = (drow ?? [])
        .map((c) => cellStr(c))
        .filter(Boolean)
        .join(" ");
      if (text.length < 4 || text.length > 500) continue;
      if (
        !/cuscinett|\bbearing\b|\bCUS-[A-Z0-9-]+/i.test(text) &&
        !/\b2\d{4}\s*E[A-Z]?\b/i.test(text)
      ) {
        continue;
      }
      const key = text.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ descriptionEN: text, source: "hint" });
    }
  }
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
  const { grids, bomIndexD4 } = readWorkbook(filePath);
  const header = extractHeader(grids, bomIndexD4);
  const format: ParsedBom["format"] = grids["Structured"]
    ? "structured"
    : grids["1"]
      ? "config"
      : "unknown";
  const { rows, warnings } = extractAllBomRows(grids);
  if (format === "unknown") appendBearingHints(grids, rows);
  const bom = withoutChainsMissingLength(rows, header, grids, warnings);
  return {
    file: filePath.split(/[\\/]/).pop() ?? filePath,
    format,
    header,
    bom,
    warnings,
  };
}

/** "TM 100 CLC" → "TM100CLC". "TM 75 2RP" → "TM75 2RP": il 2RP resta in descrizione. */
function compactTm(desc: string): string {
  return desc.replace(
    /\bTM\s+(\d+(?:\s+[A-Z]{1,4})*)(?:\s+(\d[A-Z0-9]*(?:\s+[A-Z0-9]+)*))?/gi,
    (_, head: string, exec?: string) => {
      const base = `TM${String(head).replace(/\s+/g, "")}`;
      return exec ? `${base} ${exec.toUpperCase()}` : base;
    }
  );
}

function sectionCode(grid: Grid | undefined, title: RegExp): string {
  if (!grid) return "";
  for (let r = 0; r < grid.length; r++) {
    const label = cellStr(grid[r]?.[1]);
    if (!title.test(label)) continue;
    for (const cell of grid[r] ?? []) {
      const code = cellStr(cell);
      if (/^C\d{4,}/i.test(code)) return code;
    }
    for (let h = r + 1; h < Math.min(grid.length, r + 4); h++) {
      const header = grid[h] ?? [];
      const col = header.findIndex((c) => /drawing/.test(norm(c)));
      if (col < 0) continue;
      const code = cellStr(grid[h + 1]?.[col]);
      if (!isBlankType(code)) return code;
    }
  }
  return "";
}

/** 1-1/2"D, 1"1/2 o 2" → 1-1/2, 1-1/2, 2. Il semplice/doppio non entra nel codice. */
function couplingPitchToken(raw: string): string {
  let s = raw
    .toUpperCase()
    .trim()
    .replace(/(\d)\s+(?=\d)/g, "$1-")
    .replace(/\s+/g, "");
  s = s.replace(/["″'][DS]?$/, "");
  s = s.replace(/["″']/g, "-");
  if (/[/-]/.test(s)) s = s.replace(/[DS]$/, "");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return /^\d+(?:-\d+\/\d+)?$/.test(s) ? s : "";
}

/** IV003871.1-B → IV003871, poi il passo: IV003871-1-1/2. */
function chainCouplingSellCode(grid: Grid | undefined): string {
  if (!grid) return "";
  for (let r = 0; r < grid.length; r++) {
    const label = cellStr(grid[r]?.[1]);
    if (!/chain coupling|giunto a catena/i.test(label)) continue;
    for (let h = r + 1; h < Math.min(grid.length, r + 4); h++) {
      const header = grid[h] ?? [];
      const drawCol = header.findIndex((c) => /drawing/.test(norm(c)));
      if (drawCol < 0) continue;
      const data = grid[h + 1] ?? [];
      const stem = cellStr(data[drawCol]).toUpperCase().match(/^[A-Z]+\d+/)?.[0] ?? "";
      if (!stem) continue;
      const pitchCol = header.findIndex((c) => norm(c) === "pitch" || norm(c) === "passo");
      const pitch = pitchCol >= 0 ? couplingPitchToken(cellStr(data[pitchCol])) : "";
      return pitch ? `${stem}-${pitch}` : stem;
    }
  }
  return "";
}

/** Se la distinta ha solo il disegno, il passo può stare nel testo "1-1/2". */
function composeCouplingCode(code: string, description: string): string {
  const quoted = description.toUpperCase().match(/(\d+(?:\s*-\s*\d+\s*\/\s*\d+)?)\s*["″']/);
  const pitch = quoted ? couplingPitchToken(quoted[1]) : "";
  if (code && pitch && /^[A-Z]+\d+$/i.test(code)) return `${code}-${pitch}`;
  return code;
}

/**
 * Coclea (foglio SPARE PARTS): le righe con flag S e quantità > 0 sono i ricambi.
 * Il supporto TM resta un'unica riga: cuscinetti e tenute li aggiunge il listino.
 */
export function extractSchedaBom(grids: Record<string, Grid>): {
  rows: BomRow[];
  warnings: string[];
  sheetUsed?: string;
} | null {
  const grid = grids["SPARE PARTS"];
  if (!grid?.length) return null;
  let headerIdx = -1;
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const joined = (grid[r] ?? []).map(norm);
    if (joined.some((cell) => cell === "installed qty" || cell.includes("installed qty"))) {
      headerIdx = r;
      break;
    }
  }
  if (headerIdx < 0) return null;
  const header = grid[headerIdx] ?? [];
  const flagCol = findColIndex(header, ["spare parts"]);
  const qtyCol = findColIndex(header, ["installed qty"]);
  const codeCol = findColIndex(header, ["cod.", "cod", "code"]);
  const kindCol = findColIndex(header, ["indicw"]);
  const umCol = findColIndex(header, ["u.m", "um", "u.m."]);
  const machineCol = findColIndex(header, ["description"]);
  if (flagCol < 0 || qtyCol < 0) return null;

  const distinta = grids["Distinta EN"] ?? grids["Distinta"];
  const couplingCode = chainCouplingSellCode(distinta);
  const driveCode = sectionCode(distinta, /^drive supports$/i);

  const rows: BomRow[] = [];
  const warnings: string[] = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const flag = cellStr(row[flagCol]).toUpperCase();
    if (flag !== "S") continue;
    const qty = parseNum(row[qtyCol]);
    if (!qty || qty <= 0) continue;
    let description = "";
    for (let c = qtyCol - 1; c > flagCol; c--) {
      if (c === machineCol || c === codeCol || c === kindCol) continue;
      const text = cellStr(row[c]);
      if (isBlankType(text) || text.length < 3) continue;
      if (/^bf\d/i.test(text)) continue;
      if (/^(nr|pz|mt|mm|kg)$/i.test(text)) continue;
      if (/^\d+([.,]\d+)?$/.test(text)) continue;
      description = text;
      break;
    }
    if (!description) continue;
    const kind = kindCol >= 0 ? cellStr(row[kindCol]).toUpperCase() : "";
    description = compactTm(description.replace(/\s+/g, " ").trim());
    const namedSprinkler =
      kind === "SPR" || /minimax|sprinkler/i.test(description)
        ? sprinklerOfferName(description)
        : null;
    if (namedSprinkler) description = namedSprinkler.description;
    else if ((kind === "SPR" || /minimax|sprinkler/i.test(description)) && !/sprinkler/i.test(description)) {
      description = `Sprinkler ${description}`;
    }

    let partNumber = namedSprinkler?.code || (codeCol >= 0 ? cellStr(row[codeCol]) : "");
    if (isBlankType(partNumber)) {
      const supportModel = description.match(/\b((?:SNL|SNH|FNL|UKT)\s*\d+\s*[A-Z]*)\b/i);
      if (/chain\s*coupling|giunto/i.test(description) && !/coverjoint|coprigiunto/i.test(description)) {
        partNumber = couplingCode || "GIUNTO";
      }
      else if (/\bTM\d/i.test(description)) partNumber = driveCode || "TM";
      else if (supportModel) partNumber = supportModel[1].replace(/\s+/g, " ").trim();
      else if (/^chain\b/i.test(description)) partNumber = "CHAIN";
      else partNumber = description.split(/\s+/).slice(0, 3).join(" ");
    }
    if (/chain\s*coupling|giunto/i.test(description) && !/coverjoint|coprigiunto/i.test(description)) {
      const built = composeCouplingCode(couplingCode, description);
      if (built) partNumber = built;
      else if (isBlankType(partNumber)) partNumber = "GIUNTO";
    }
    if (/explosion|portell/i.test(`${description} ${partNumber}`)) {
      const measure = doorMeasure(`${description} ${partNumber}`);
      if (measure) {
        partNumber = `PEX-EXGO-${measure}`;
        description = `Explosion proof door PORTELL ${measure}`;
      }
    }
    const umRaw = umCol >= 0 ? cellStr(row[umCol]) : "";
    const detailParts: string[] = [];
    for (let c = 0; c < row.length; c++) {
      if (c === flagCol || c === qtyCol || c === codeCol || c === kindCol || c === umCol || c === machineCol) {
        continue;
      }
      const text = cellStr(row[c]);
      if (!text || text === description || text === partNumber) continue;
      if (/\bCUS-[A-Z0-9-]+/i.test(text) || /\b2\d{4}\b/.test(text) || /cuscinett|\bbearing\b/i.test(text)) {
        detailParts.push(text);
      }
    }
    rows.push({
      partNumber,
      descriptionEN: description,
      qty,
      um: /^m(t|m)?$/i.test(umRaw) ? "MT" : umRaw && !isBlankType(umRaw) ? umRaw : "NR",
      source: "scheda",
      detail: detailParts.join(" ") || undefined,
    });
  }
  if (!rows.length) {
    warnings.push("Scheda SPARE PARTS: nessuna riga con flag S e quantità installata.");
  }
  return { rows, warnings, sheetUsed: "SPARE PARTS" };
}

/**
 * Tutte le righe della distinta (Parts only / Structured / scheda coclea / config).
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
  const scheda = extractSchedaBom(grids);
  if (scheda) return scheda;
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
