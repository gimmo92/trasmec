import fs from "node:fs";
import path from "node:path";
import { readWorkbookGrids, type Grid } from "./excel";

export interface DistintaMeta {
  file: string;
  commessa: string;
  matricola: string;
  macchina: string;
  cliente: string;
  descrizione: string;
  asservimento: string;
}

export interface DistintaComponent {
  qty: number;
  role: string;
  tipo: string;
}

export interface DistintaSection {
  title: string;
  code: string;
  enabled: boolean;
  fields: Record<string, string>;
  components: DistintaComponent[];
}

export interface DistintaFile {
  meta: DistintaMeta;
  sections: DistintaSection[];
}

function docsDir(): string {
  const fromEnv = process.env.TRASMEC_DOCS_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "..", "trasmec docs v2");
}

export function sorgenteRoot(): string {
  return path.join(docsDir(), "file sorgente");
}

function cell(row: Grid[number] | undefined, index: number): string {
  const value = row?.[index];
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function labelAt(grid: Grid, label: string): string {
  const wanted = norm(label);
  for (let i = 0; i < grid.length - 1; i++) {
    const row = grid[i];
    for (let j = 0; j < row.length; j++) {
      if (norm(cell(row, j)) !== wanted) continue;
      const below = cell(grid[i + 1], j);
      if (below && below !== "0") return below;
    }
  }
  return "";
}

function isSectionTitle(row: Grid[number] | undefined, next: Grid[number] | undefined): boolean {
  if (!row) return false;
  if (cell(row, 17).toLowerCase().startsWith("flg_")) return Boolean(cell(row, 1));
  const title = cell(row, 1);
  if (title.length < 3) return false;
  const nextLabel = norm(cell(next, 1) || cell(next, 2));
  return nextLabel === "quant." || nextLabel === "quant";
}

function headerMap(row: Grid[number] | undefined): { col: number; name: string }[] {
  if (!row) return [];
  const headers: { col: number; name: string }[] = [];
  row.forEach((value, col) => {
    const name = norm(cell([value], 0)).replace(/\.$/, "");
    if (!name || name === "0") return;
    headers.push({ col, name });
  });
  return headers;
}

function parseQty(raw: string): number {
  const cleaned = raw.replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseDistintaGrid(grid: Grid, file: string): DistintaFile {
  const meta: DistintaMeta = {
    file,
    commessa: labelAt(grid, "commessa"),
    matricola: labelAt(grid, "matricola"),
    macchina: labelAt(grid, "codice macchina"),
    cliente: labelAt(grid, "cliente"),
    descrizione: labelAt(grid, "descrizione"),
    asservimento: labelAt(grid, "asservimento"),
  };

  const sections: DistintaSection[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!isSectionTitle(grid[i], grid[i + 1])) continue;
    const title = cell(grid[i], 1);
    const code = cell(grid[i], 4);
    const flagged = cell(grid[i], 17).toLowerCase().startsWith("flg_");
    const switchedOn = cell(grid[i], 0).toUpperCase() === "X" || Number(grid[i]?.[16]) === 1;
    const headers = headerMap(grid[i + 1]);
    const data: Grid = [];
    for (let r = i + 2; r < grid.length; r++) {
      if (isSectionTitle(grid[r], grid[r + 1])) break;
      const useful = [1, 2, 3, 4, 5, 6].some((col) => {
        const value = cell(grid[r], col);
        return value && value !== "0" && value !== "-";
      });
      if (!useful) {
        if (data.length) break;
        continue;
      }
      data.push(grid[r]);
    }

    const fields: Record<string, string> = {};
    const first = data[0];
    if (first) {
      for (const header of headers) {
        if (header.name === "quant") {
          const value = cell(first, header.col);
          if (value && value !== "-" && value !== "0") fields[header.name] = value;
          continue;
        }
        const values = [
          ...new Set(
            data
              .map((row) => cell(row, header.col))
              .filter((value) => value && value !== "-" && value !== "0")
          ),
        ];
        if (values.length) fields[header.name] = values.join(" / ");
      }
    }

    const components: DistintaComponent[] = [];
    for (const row of data) {
      const role = cell(row, 3);
      const tipo = cell(row, 4);
      const qty = parseQty(cell(row, 1));
      if (!/^[A-Za-zÀ-ÿ]{3,}/.test(role) || !tipo || norm(role) === "tipo") continue;
      components.push({ qty, role, tipo });
    }

    const enabled = flagged
      ? switchedOn
      : components.some((item) => item.qty > 0) || parseQty(fields.quant || "") > 0;

    sections.push({
      title,
      code: /^[A-Z0-9][A-Z0-9._-]{2,}$/i.test(code) ? code : "",
      enabled,
      fields,
      components: components.filter((item) => item.qty > 0),
    });
  }

  return { meta, sections };
}

export function readDistinta(filePath: string): DistintaFile | null {
  const grids = readWorkbookGrids(filePath);
  const sheet = grids.Distinta || Object.values(grids)[0];
  if (!sheet) return null;
  return parseDistintaGrid(sheet, filePath);
}

export interface SourceHit {
  dir: string;
  files: string[];
  distinte: DistintaFile[];
}

/** Sceglie la cartella allegati il cui nome o i file combaciano con ticket, commessa o codici. */
export function findSource(needles: string[]): SourceHit | null {
  const root = path.join(sorgenteRoot(), "allegati");
  if (!fs.existsSync(root)) return null;
  const keys = needles
    .map((item) => item.toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter((item) => item.length >= 4);

  let best: { score: number; dir: string; files: string[] } | null = null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const files = fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith("~$"))
      .map((name) => path.join(dir, name));
    let score = 0;
    const folderKey = entry.name.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (keys.some((key) => key === folderKey || (folderKey.length >= 6 && key.includes(folderKey)))) {
      score += 100;
    }
    for (const file of files) {
      const name = path.basename(file).toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (keys.some((key) => name.includes(key) || key.includes(name))) score += 40;
    }
    if (!best || score > best.score) best = { score, dir, files };
  }
  if (!best || best.score <= 0) return null;

  const distinte = best.files
    .filter((file) => /\.xlsx$/i.test(file))
    .map((file) => readDistinta(file))
    .filter((item): item is DistintaFile => Boolean(item));

  return { dir: best.dir, files: best.files, distinte };
}
