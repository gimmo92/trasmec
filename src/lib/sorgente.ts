import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
  const value = row?.[index] as string | number | Date | null | undefined;
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

/** Riga con solo un titolo in colonna B e nient'altro: apre un blocco nuovo. */
function isBlockTitle(row: Grid[number] | undefined): boolean {
  if (!/^[A-Za-zÀ-ÿ]{3,}/.test(cell(row, 1))) return false;
  for (let col = 2; col <= 16; col++) {
    const value = cell(row, col);
    if (value && value !== "0" && value !== "-") return false;
  }
  return true;
}

/** Seconda riga d'intestazione: solo etichette, nessun numero. */
function isSubHeader(row: Grid[number] | undefined): boolean {
  if (!row) return false;
  let labels = 0;
  for (let col = 1; col <= 16; col++) {
    const value = cell(row, col);
    if (!value || value === "-") continue;
    if (/^-?\d+(?:[.,]\d+)?$/.test(value) || /\d{3}\.\d{2}/.test(value)) return false;
    labels += 1;
  }
  return labels >= 2;
}

/** Nomi colonna = riga sopra + riga sotto ("allestimento codice"); la quantità resta "quant". */
function mergeSubHeader(
  headers: { col: number; name: string }[],
  sub: Grid[number] | undefined
): { col: number; name: string }[] {
  const subNames = new Map(headerMap(sub).map((item) => [item.col, item.name]));
  const merged = headers.map((header) => {
    const extra = subNames.get(header.col);
    if (!extra || header.name === "quant") return header;
    return { col: header.col, name: `${header.name} ${extra}` };
  });
  for (const [col, name] of subNames) {
    if (!merged.some((header) => header.col === col)) merged.push({ col, name });
  }
  return merged.sort((a, b) => a.col - b.col);
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
    let headers = headerMap(grid[i + 1]);
    const data: Grid = [];
    for (let r = i + 2; r < grid.length; r++) {
      if (isSectionTitle(grid[r], grid[r + 1])) break;
      // Titolo di un blocco successivo (es. "Ruote portasettori" sotto la catena): la sezione finisce.
      if (data.length && isBlockTitle(grid[r])) break;
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
    // Intestazione su due righe (es. catena: "quant. | allestimento" sopra "(m) | codice"):
    // la seconda riga completa i nomi delle colonne, non è un dato.
    const quantCol = headers.find((header) => header.name === "quant")?.col;
    const quantLabel = quantCol === undefined ? "" : cell(data[0], quantCol);
    if (
      data.length > 1 &&
      quantLabel &&
      !/\d/.test(quantLabel) &&
      isSubHeader(data[0])
    ) {
      headers = mergeSubHeader(headers, data.shift());
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
              .filter((value) => value && value !== "-" && value !== "0" && !/^quant\.?$/i.test(value))
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

/** File sorgente caricato dall'utente: le distinte Excel col contenuto, gli altri solo col nome. */
export interface SorgenteCaricato {
  name: string;
  data?: Buffer;
}

const EXCEL_DISTINTA = /\.(xlsx|xlsm|xls)$/i;

/**
 * Usa i file indicati dall'utente al posto della ricerca in cartella.
 * Le distinte vengono scritte in una cartella temporanea (funziona anche online) e poi tolte.
 */
export function sourceFromUpload(files: SorgenteCaricato[]): SourceHit | null {
  if (!files.length) return null;
  const dir = path.join(os.tmpdir(), "trasmec-sorgente", randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const paths: string[] = [];
    const distinte: DistintaFile[] = [];
    for (const file of files) {
      const name = path.basename(file.name).replace(/[^\w.\- ()[\]]+/g, "_");
      if (!name) continue;
      const full = path.join(dir, name);
      paths.push(full);
      if (!file.data || !EXCEL_DISTINTA.test(name)) continue;
      fs.writeFileSync(full, file.data);
      try {
        const distinta = readDistinta(full);
        if (distinta) distinte.push(distinta);
      } catch {
        // Excel che non è una distinta: resta tra le fonti, senza voci.
      }
    }
    return { dir, files: paths, distinte };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
