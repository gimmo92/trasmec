import path from "node:path";
import { readWorkbookGrids, parseNum, recommendedFromInstalled, type Grid } from "./excel";
import { isJobNr, jobCode } from "./jobcode";
import { extractPdfCells, type PdfTextCell } from "./orderpdf";
import type { ProposalLine } from "./types";

/** Riga motore/sensore con il codice distinta (job) per il raggruppamento. */
export interface MsRow {
  jobNr: string; // es. BE0806C
  jobBase: string; // es. BE0806
  line: ProposalLine;
}

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** Estrae il codice base da un job (es. "BE0806C" o "BE-2694" -> "BE2694"). */
export function jobBase(job: string): string {
  const compact = job.toUpperCase().replace(/-(?=\d)/g, "");
  return jobCode(compact) ?? compact.trim();
}

/** Individua la colonna del "job" cercando la colonna con più valori tipo BE####. */
function detectJobCol(grid: Grid): number {
  const counts: Record<number, number> = {};
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (isJobNr(cellStr(row[c]))) counts[c] = (counts[c] ?? 0) + 1;
    }
  }
  let best = 1;
  let bestN = -1;
  for (const [c, n] of Object.entries(counts)) {
    if (n > bestN) {
      bestN = n;
      best = Number(c);
    }
  }
  return best;
}

/** Trova la prima riga dati (primo BE#### nella colonna job). */
function firstDataRow(grid: Grid, jobCol: number): number {
  for (let r = 0; r < grid.length; r++) {
    if (isJobNr(cellStr(grid[r]?.[jobCol]))) return r;
  }
  return -1;
}

/** Parsa la lista motori (file ...-ML.xlsx, foglio "ML"). */
function parseMotorExcel(filePath: string): MsRow[] {
  const grids = readWorkbookGrids(filePath);
  const grid = grids["ML"] ?? Object.values(grids)[0];
  if (!grid) return [];
  const jc = detectJobCol(grid);
  const start = firstDataRow(grid, jc);
  if (start < 0) return [];

  const out: MsRow[] = [];
  let lastJob = "";
  for (let r = start; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const item = cellStr(row[jc - 1]);
    const jobCell = cellStr(row[jc]);
    if (jobCell) lastJob = jobCell;
    const job = jobCell || lastJob;
    const qty = cellStr(row[jc + 2]);
    const art = cellStr(row[jc + 3]);
    const power = cellStr(row[jc + 4]);
    const type = cellStr(row[jc + 7]);
    // Solo motori con codice item MR… (es. MR005245)
    if (!/^MR/i.test(item)) continue;
    if (!job) continue;

    const installed = parseNum(qty) ?? 1;
    const desc = [type, art, power ? `${power} kW` : ""].filter(Boolean).join(" ");
    out.push({
      jobNr: job,
      jobBase: jobBase(job),
      line: {
        code: item || type || "MOTORE",
        descriptionEN: desc || undefined,
        descriptionIT: desc || undefined,
        installedQty: installed,
        recommendedQty: recommendedFromInstalled(installed),
        um: "NR",
        category: "motor",
        motorType: type || undefined,
        power: power || undefined,
      },
    });
  }
  return out;
}

/** Parsa la lista sensori (file ...-SL.xlsx, foglio "SL"). */
function parseSensorExcel(filePath: string): MsRow[] {
  const grids = readWorkbookGrids(filePath);
  const grid = grids["SL"] ?? Object.values(grids)[0];
  if (!grid) return [];
  const jc = detectJobCol(grid);
  const start = firstDataRow(grid, jc);
  if (start < 0) return [];

  const out: MsRow[] = [];
  let lastJob = "";
  for (let r = start; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const item = cellStr(row[jc - 1]);
    const jobCell = cellStr(row[jc]);
    if (jobCell) lastJob = jobCell;
    const job = jobCell || lastJob;
    const qty = cellStr(row[jc + 2]);
    const designation = cellStr(row[jc + 3]);
    const model = cellStr(row[jc + 7]);
    const supplier = cellStr(row[jc + 11]);
    const atex = cellStr(row[jc + 12]);
    const note = cellStr(row[jc + 13]);
    if (!item && !designation && !model) continue;
    if (!job) continue;

    const installed = parseNum(qty) ?? 1;
    const desc = [designation, model].filter(Boolean).join(" - ");
    out.push({
      jobNr: job,
      jobBase: jobBase(job),
      line: {
        code: item || model || "SENSORE",
        descriptionEN: desc || undefined,
        descriptionIT: desc || undefined,
        installedQty: installed,
        recommendedQty: recommendedFromInstalled(installed),
        um: "NR",
        category: "sensor",
        model: model || undefined,
        supplier: supplier || undefined,
        atex: atex && atex !== "0" ? atex : undefined,
        notes: note && note !== "0" ? note : undefined,
      },
    });
  }
  return out;
}

const JOB_TOKEN = /^B[A-Z]-?\d{4}[A-Z]?$/i;
const SENSOR_CODE = /^[A-Z]{2,4}\d{3,}(?:[-+][A-Z0-9]+)*$/i;

function isJobToken(text: string): boolean {
  return JOB_TOKEN.test(text.trim());
}

function headerX(cells: PdfTextCell[], test: RegExp): number | undefined {
  return cells.find((cell) => test.test(cell.text.trim()))?.x;
}

function hasLetter(text: string): boolean {
  return /[A-Z]/i.test(text);
}

/** Cella della riga più vicina alla colonna. Un codice con lettere vince su un numero della colonna accanto se distano meno di 2 pt. */
function closestText(cells: PdfTextCell[], x: number | undefined, maxDx: number): string {
  if (x == null) return "";
  let best = "";
  let bestD = maxDx;
  let bestX = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    const d = Math.abs(cell.x - x);
    if (d > maxDx) continue;
    const gap = d - bestD;
    const sameKind = hasLetter(cell.text) === hasLetter(best);
    const nearer = gap < -2 || (gap < 0 && sameKind);
    const letterWins = hasLetter(cell.text) && !hasLetter(best) && d <= bestD + 2;
    const leftWins = sameKind && Math.abs(gap) <= 0.2 && cell.x < bestX;
    if (nearer || letterWins || leftWins) {
      best = cell.text;
      bestD = d;
      bestX = cell.x;
    }
  }
  return best;
}

function nearestJob(y: number, jobs: { y: number; job: string }[]): string | undefined {
  let best: { job: string; d: number; y: number } | undefined;
  for (const job of jobs) {
    const d = Math.abs(job.y - y);
    if (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && job.y < best.y)) {
      best = { job: job.job, d, y: job.y };
    }
  }
  if (!best || best.d > 36) return undefined;
  return best.job;
}

/** Lista motori stampata in PDF: una riga per commessa, con l'articolo MR. */
async function parseMotorPdf(filePath: string): Promise<MsRow[]> {
  const cells = await extractPdfCells(filePath);
  const qtyX = headerX(cells, /^QTY$/i);
  const artX = headerX(cells, /^Art\.?$/i);
  const powerX = headerX(cells, /^KW$/i);
  const typeX = headerX(cells, /^type$/i);
  const denomX = headerX(cells, /DENOMINATION/i);
  const itemX = headerX(cells, /^ITEM$/i);
  const jobs = cells.filter((cell) => isJobToken(cell.text));
  const out: MsRow[] = [];
  for (const jobCell of jobs) {
    const job = jobCell.text.toUpperCase().replace(/-(?=\d)/g, "");
    const base = jobBase(job);
    if (!/^B[A-Z]\d{4}/.test(base)) continue;
    const near = cells.filter((cell) => cell !== jobCell && Math.abs(cell.y - jobCell.y) <= 8);
    const art = closestText(near, artX, 24);
    const item = closestText(near, itemX, 18);
    if (!/^MR$/i.test(art) && !/^MR/i.test(item)) continue;
    const installed = parseNum(closestText(near, qtyX, 24)) ?? 1;
    const power = closestText(near, powerX, 24);
    const type = closestText(near, typeX, 24);
    const denom = closestText(near, denomX, 40);
    const code = (/^MR/i.test(item) ? item : "") || denom || type || "MOTORE";
    const desc = [art && art !== code ? art : "", type, power ? `${power} kW` : ""]
      .filter(Boolean)
      .join(" ");
    out.push({
      jobNr: job,
      jobBase: base,
      line: {
        code,
        descriptionEN: desc || undefined,
        descriptionIT: desc || undefined,
        installedQty: installed,
        recommendedQty: recommendedFromInstalled(installed),
        um: "NR",
        category: "motor",
        motorType: type || undefined,
        power: power || undefined,
      },
    });
  }
  return out;
}

/** Lista sensori stampata in PDF: i sensori stanno sulla riga della commessa o subito intorno. */
async function parseSensorPdf(filePath: string): Promise<MsRow[]> {
  const cells = await extractPdfCells(filePath);
  const qtyX = headerX(cells, /^(?:QTY|nr\.?)$/i);
  const designationX = headerX(cells, /^DESIGNATION$/i);
  const modelX = headerX(cells, /^TYPE$/i);
  const supplierX = headerX(cells, /^SUPPLIER$/i);
  const atexX = headerX(cells, /^Atex$/i);
  const jobs = cells
    .filter((cell) => isJobToken(cell.text))
    .map((cell) => ({
      y: cell.y,
      job: cell.text.toUpperCase().replace(/-(?=\d)/g, ""),
    }));
  const items = cells.filter(
    (cell) => cell.x < 110 && SENSOR_CODE.test(cell.text.replace(/\s+/g, "")) && !isJobToken(cell.text)
  );
  const out: MsRow[] = [];
  for (const itemCell of items) {
    const job = nearestJob(itemCell.y, jobs);
    if (!job) continue;
    const base = jobBase(job);
    const near = cells.filter(
      (cell) =>
        cell !== itemCell &&
        !isJobToken(cell.text) &&
        !SENSOR_CODE.test(cell.text.replace(/\s+/g, "")) &&
        Math.abs(cell.y - itemCell.y) <= 4.5
    );
    const installed = parseNum(closestText(near, qtyX, 24)) ?? 1;
    const designation = closestText(near, designationX, 30);
    const model = closestText(near, modelX, 30);
    const supplier = closestText(near, supplierX, 30);
    const atex = closestText(near, atexX, 24);
    const desc = [designation, model].filter(Boolean).join(" - ");
    out.push({
      jobNr: job,
      jobBase: base,
      line: {
        code: itemCell.text.replace(/\s+/g, ""),
        descriptionEN: desc || undefined,
        descriptionIT: desc || undefined,
        installedQty: installed,
        recommendedQty: recommendedFromInstalled(installed),
        um: "NR",
        category: "sensor",
        model: model || undefined,
        supplier: supplier || undefined,
        atex: atex && atex !== "0" ? atex : undefined,
      },
    });
  }
  return out;
}

/** Lista motori Excel (foglio ML) oppure PDF della stessa lista. */
export async function parseMotorList(filePath: string): Promise<MsRow[]> {
  if (path.extname(filePath).toLowerCase() === ".pdf") return parseMotorPdf(filePath);
  return parseMotorExcel(filePath);
}

/** Lista sensori Excel (foglio SL) oppure PDF della stessa lista. */
export async function parseSensorList(filePath: string): Promise<MsRow[]> {
  if (path.extname(filePath).toLowerCase() === ".pdf") return parseSensorPdf(filePath);
  return parseSensorExcel(filePath);
}

/** Raggruppa le righe motore/sensore per codice base della distinta. */
export function groupByJobBase(rows: MsRow[]): Map<string, ProposalLine[]> {
  const map = new Map<string, ProposalLine[]>();
  for (const r of rows) {
    const arr = map.get(r.jobBase) ?? [];
    arr.push(r.line);
    map.set(r.jobBase, arr);
  }
  return map;
}
