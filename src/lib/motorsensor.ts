import { readWorkbookGrids, parseNum, recommendedFromInstalled, type Grid } from "./excel";
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

/** Estrae il codice base BE#### da un job (es. "BE0806C" -> "BE0806"). */
export function jobBase(job: string): string {
  const m = job.match(/BE\d{4}/i);
  return m ? m[0].toUpperCase() : job.trim().toUpperCase();
}

/** Individua la colonna del "job" cercando la colonna con più valori tipo BE####. */
function detectJobCol(grid: Grid): number {
  const counts: Record<number, number> = {};
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      if (/^BE\d{4}[A-Z]?$/i.test(cellStr(row[c]))) counts[c] = (counts[c] ?? 0) + 1;
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
    if (/^BE\d{4}[A-Z]?$/i.test(cellStr(grid[r]?.[jobCol]))) return r;
  }
  return -1;
}

/** Parsa la lista motori (file ...-ML.xlsx, foglio "ML"). */
export function parseMotorList(filePath: string): MsRow[] {
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
export function parseSensorList(filePath: string): MsRow[] {
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
