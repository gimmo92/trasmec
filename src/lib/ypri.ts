import fs from "node:fs";
import path from "node:path";
import { listDocumenti, resolveDocumento } from "./documenti";
import type { ProposalLine } from "./types";

/** Provenienza di un coefficiente commerciale. */
export interface PriceSource {
  file: string;
  listino?: string;
}

/** Esito del calcolo prezzo di vendita. */
export interface PriceResult {
  article: string;
  customerCode?: string;
  found: boolean;
  basePrice: number;
  famiglia: string;
  sottofamiglia: string;
  uv: string;
  ctm: number;
  ctmSource?: PriceSource;
  maggiorazione: number;
  maggiorazioneSource?: PriceSource;
  sconto: number;
  scontoSource?: PriceSource;
  /** Prezzo dopo CTM e maggiorazione, prima dello sconto. */
  unitPrice: number;
  /** Prezzo finale di vendita. */
  salePrice: number;
}

interface ArticleRow {
  prezzo: number;
  famiglia: string;
  sottofamiglia: string;
  uv: string;
}

interface CoeffRow {
  listino: string;
  file: string;
  cliente?: string;
  gruppo?: string;
  famiglia: string;
  sottofamiglia?: string;
  uv: string;
  ctm?: number;
  maggiorazione?: number;
}

interface ScontoRow {
  listino: string;
  file: string;
  cliente?: string;
  gruppo?: string;
  famiglia: string;
  sconto: number;
}

interface YpriTables {
  articles: Map<string, ArticleRow>;
  clients: Map<string, string>;
  /** YPRIAI02…07 in ordine di priorità. */
  coeffs: CoeffRow[][];
  scontiCliente: ScontoRow[];
  scontiGruppo: ScontoRow[];
  /** mtime e dimensione di ogni CSV: un listino sostituito si ricarica anche a parità di data. */
  stamp: string;
}

let cache: YpriTables | null = null;

function parseItNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text || text === "-" || /^\/+$/.test(text.replace(/\s/g, ""))) return undefined;
  const normalized = text.includes(",")
    ? text.replace(/\./g, "").replace(",", ".")
    : text;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

function cell(row: string[], index: number): string {
  return (row[index] ?? "").trim();
}

/** Split CSV con `;` e campi tra virgolette. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsvRows(filePath: string): string[][] {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];
  return lines.slice(1).map(parseCsvLine);
}

function normKey(value: string): string {
  return value.trim().toUpperCase();
}

/** Codici cliente a 6 cifre: allinea zeri iniziali. */
function normClient(value: string): string {
  const t = value.trim();
  if (/^\d+$/.test(t)) return t.padStart(6, "0");
  return t;
}

function ypriPath(name: string): string | null {
  try {
    return resolveDocumento(name);
  } catch {
    const local = path.join(process.cwd(), "documenti", name);
    return fs.existsSync(local) ? local : null;
  }
}

function tablesStamp(names: string[]): string {
  const parts: string[] = [];
  for (const name of names) {
    const full = ypriPath(name);
    if (!full) {
      parts.push(`${name}:missing`);
      continue;
    }
    try {
      const stat = fs.statSync(full);
      parts.push(`${full}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${name}:err`);
    }
  }
  return parts.join("|");
}

function loadTables(): YpriTables {
  const names = [
    "YPRIAI00.csv",
    "YPRIAI01.csv",
    "YPRIAI02.csv",
    "YPRIAI03.csv",
    "YPRIAI04.csv",
    "YPRIAI05.csv",
    "YPRIAI06.csv",
    "YPRIAI07.csv",
    "YPRIAI08.csv",
    "YPRIAI09.csv",
  ];
  const stamp = tablesStamp(names);
  if (cache && cache.stamp === stamp) return cache;

  const articles = new Map<string, ArticleRow>();
  const path00 = ypriPath("YPRIAI00.csv");
  if (path00) {
    for (const row of readCsvRows(path00)) {
      const article = cell(row, 0);
      if (!article) continue;
      articles.set(normKey(article), {
        prezzo: parseItNumber(cell(row, 2)) ?? 0,
        uv: cell(row, 4),
        famiglia: cell(row, 5),
        sottofamiglia: cell(row, 6),
      });
    }
  }

  const clients = new Map<string, string>();
  const path01 = ypriPath("YPRIAI01.csv");
  if (path01) {
    for (const row of readCsvRows(path01)) {
      const cliente = cell(row, 0);
      const gruppo = cell(row, 1);
      if (!cliente) continue;
      clients.set(normClient(cliente), normClient(gruppo || cliente));
    }
  }

  const coeffSpecs: {
    file: string;
    kind: "gruppo-fam-sot" | "gruppo-fam" | "cli-fam-sot" | "cli-fam" | "fam-sot" | "fam";
  }[] = [
    { file: "YPRIAI02.csv", kind: "gruppo-fam-sot" },
    { file: "YPRIAI03.csv", kind: "gruppo-fam" },
    { file: "YPRIAI04.csv", kind: "cli-fam-sot" },
    { file: "YPRIAI05.csv", kind: "cli-fam" },
    { file: "YPRIAI06.csv", kind: "fam-sot" },
    { file: "YPRIAI07.csv", kind: "fam" },
  ];

  const coeffs: CoeffRow[][] = coeffSpecs.map((spec) => {
    const full = ypriPath(spec.file);
    if (!full) return [];
    const rows: CoeffRow[] = [];
    for (const row of readCsvRows(full)) {
      const listino = cell(row, 0);
      if (spec.kind === "gruppo-fam-sot") {
        rows.push({
          listino,
          file: spec.file,
          gruppo: normClient(cell(row, 1)),
          famiglia: cell(row, 2),
          sottofamiglia: cell(row, 3),
          uv: cell(row, 4),
          ctm: parseItNumber(cell(row, 5)),
          maggiorazione: parseItNumber(cell(row, 6)),
        });
      } else if (spec.kind === "gruppo-fam") {
        rows.push({
          listino,
          file: spec.file,
          gruppo: normClient(cell(row, 1)),
          famiglia: cell(row, 2),
          uv: cell(row, 3),
          ctm: parseItNumber(cell(row, 4)),
          maggiorazione: parseItNumber(cell(row, 5)),
        });
      } else if (spec.kind === "cli-fam-sot") {
        rows.push({
          listino,
          file: spec.file,
          cliente: normClient(cell(row, 1)),
          famiglia: cell(row, 2),
          sottofamiglia: cell(row, 3),
          uv: cell(row, 4),
          ctm: parseItNumber(cell(row, 5)),
          maggiorazione: parseItNumber(cell(row, 6)),
        });
      } else if (spec.kind === "cli-fam") {
        rows.push({
          listino,
          file: spec.file,
          cliente: normClient(cell(row, 1)),
          famiglia: cell(row, 2),
          uv: cell(row, 3),
          ctm: parseItNumber(cell(row, 4)),
          maggiorazione: parseItNumber(cell(row, 5)),
        });
      } else if (spec.kind === "fam-sot") {
        rows.push({
          listino,
          file: spec.file,
          famiglia: cell(row, 1),
          sottofamiglia: cell(row, 2),
          uv: cell(row, 3),
          ctm: parseItNumber(cell(row, 4)),
          maggiorazione: parseItNumber(cell(row, 5)),
        });
      } else {
        rows.push({
          listino,
          file: spec.file,
          famiglia: cell(row, 1),
          uv: cell(row, 2),
          ctm: parseItNumber(cell(row, 3)),
          maggiorazione: parseItNumber(cell(row, 4)),
        });
      }
    }
    return rows;
  });

  const scontiCliente: ScontoRow[] = [];
  const path08 = ypriPath("YPRIAI08.csv");
  if (path08) {
    for (const row of readCsvRows(path08)) {
      scontiCliente.push({
        listino: cell(row, 0),
        file: "YPRIAI08.csv",
        cliente: normClient(cell(row, 1)),
        famiglia: cell(row, 2),
        sconto: parseItNumber(cell(row, 3)) ?? 0,
      });
    }
  }

  const scontiGruppo: ScontoRow[] = [];
  const path09 = ypriPath("YPRIAI09.csv");
  if (path09) {
    for (const row of readCsvRows(path09)) {
      scontiGruppo.push({
        listino: cell(row, 0),
        file: "YPRIAI09.csv",
        gruppo: normClient(cell(row, 1)),
        famiglia: cell(row, 2),
        sconto: parseItNumber(cell(row, 3)) ?? 0,
      });
    }
  }

  cache = { articles, clients, coeffs, scontiCliente, scontiGruppo, stamp };
  return cache;
}

function eq(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase();
}

function eqUv(a: string, b: string): boolean {
  const left = a.trim().toUpperCase();
  const right = b.trim().toUpperCase();
  if (left === right) return true;
  // In offerta NR diventa PZ: i tariffari restano su NR.
  if ((left === "NR" && right === "PZ") || (left === "PZ" && right === "NR")) return true;
  return false;
}

function matchesCoeff(
  row: CoeffRow,
  ctx: { cliente?: string; gruppo?: string; famiglia: string; sottofamiglia: string; uv: string }
): boolean {
  if (row.cliente != null && (!ctx.cliente || !eq(row.cliente, ctx.cliente))) return false;
  if (row.gruppo != null && (!ctx.gruppo || !eq(row.gruppo, ctx.gruppo))) return false;
  if (!eq(row.famiglia, ctx.famiglia)) return false;
  if (row.sottofamiglia != null) {
    if (!ctx.sottofamiglia) return false;
    if (!eq(row.sottofamiglia, ctx.sottofamiglia)) return false;
  }
  if (!eqUv(row.uv, ctx.uv)) return false;
  return true;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Codici articolo del listino YPRI che iniziano con un prefisso (es. "KB-"). */
export function codiciListino(prefix: string): string[] {
  const key = normKey(prefix);
  return [...loadTables().articles.keys()].filter((code) => code.startsWith(key));
}

/**
 * Prezzo di vendita da codice articolo e, se c'è, codice cliente.
 * Se l'articolo non è in YPRIAI00 restituisce prezzi a 0.
 */
export function priceArticle(articleCode: string, customerCode?: string): PriceResult {
  const tables = loadTables();
  const article = articleCode.trim();
  const empty: PriceResult = {
    article,
    customerCode: customerCode?.trim() || undefined,
    found: false,
    basePrice: 0,
    famiglia: "",
    sottofamiglia: "",
    uv: "",
    ctm: 1,
    maggiorazione: 0,
    sconto: 0,
    unitPrice: 0,
    salePrice: 0,
  };
  if (!article) return empty;

  const base = tables.articles.get(normKey(article));
  if (!base) return empty;

  const cliente = customerCode?.trim() ? normClient(customerCode) : undefined;
  const gruppo = cliente ? tables.clients.get(cliente) : undefined;
  const ctx = {
    cliente,
    gruppo,
    famiglia: base.famiglia,
    sottofamiglia: base.sottofamiglia,
    uv: base.uv,
  };

  let ctm = 1;
  let ctmSource: PriceSource | undefined;
  let maggiorazione = 0;
  let maggiorazioneSource: PriceSource | undefined;

  for (const bucket of tables.coeffs) {
    if (ctmSource && maggiorazioneSource) break;
    for (const row of bucket) {
      if (!matchesCoeff(row, ctx)) continue;
      if (!ctmSource && row.ctm != null) {
        ctm = row.ctm;
        ctmSource = { file: row.file, listino: row.listino };
      }
      if (!maggiorazioneSource && row.maggiorazione != null) {
        maggiorazione = row.maggiorazione;
        maggiorazioneSource = { file: row.file, listino: row.listino };
      }
      if (ctmSource && maggiorazioneSource) break;
    }
  }

  let sconto = 0;
  let scontoSource: PriceSource | undefined;
  if (cliente) {
    const hitCli = tables.scontiCliente.find(
      (row) => eq(row.cliente, cliente) && eq(row.famiglia, base.famiglia)
    );
    if (hitCli) {
      sconto = hitCli.sconto;
      scontoSource = { file: hitCli.file, listino: hitCli.listino };
    } else if (gruppo) {
      const hitGrp = tables.scontiGruppo.find(
        (row) => eq(row.gruppo, gruppo) && eq(row.famiglia, base.famiglia)
      );
      if (hitGrp) {
        sconto = hitGrp.sconto;
        scontoSource = { file: hitGrp.file, listino: hitGrp.listino };
      }
    }
  }

  const unitPrice = roundMoney(base.prezzo * ctm * (1 + maggiorazione / 100));
  const salePrice = roundMoney(unitPrice * (1 - sconto / 100));

  return {
    article,
    customerCode: cliente,
    found: true,
    basePrice: base.prezzo,
    famiglia: base.famiglia,
    sottofamiglia: base.sottofamiglia,
    uv: base.uv,
    ctm,
    ctmSource,
    maggiorazione,
    maggiorazioneSource,
    sconto,
    scontoSource,
    unitPrice,
    salePrice,
  };
}

/** Applica i prezzi YPRI a una riga di proposta. */
export function applyPriceToLine(line: ProposalLine, customerCode?: string): ProposalLine {
  const result = priceArticle(line.code, customerCode);
  return {
    ...line,
    unitPrice: result.unitPrice,
    discountPct: result.sconto,
    salePrice: result.salePrice,
    priceTrace: {
      found: result.found,
      basePrice: result.basePrice,
      ctm: result.ctm,
      ctmFile: result.ctmSource?.file,
      ctmListino: result.ctmSource?.listino,
      maggiorazione: result.maggiorazione,
      maggiorazioneFile: result.maggiorazioneSource?.file,
      maggiorazioneListino: result.maggiorazioneSource?.listino,
      sconto: result.sconto,
      scontoFile: result.scontoSource?.file,
      scontoListino: result.scontoSource?.listino,
    },
  };
}

/** Applica i prezzi a tutte le righe dell'offerta. */
export function applyPricesToOfferLines(
  lines: ProposalLine[],
  customerCode?: string
): ProposalLine[] {
  return lines.map((line) => applyPriceToLine(line, customerCode));
}

/** True se in archivio c'è almeno YPRIAI00. */
export function hasYpriArticles(): boolean {
  return listDocumenti().some((doc) => /^YPRIAI00\.csv$/i.test(doc.name));
}
