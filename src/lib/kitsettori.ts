import fs from "node:fs";
import * as XLSX from "xlsx";
import { listDocumenti, resolveDocumento } from "./documenti";
import { priceArticle } from "./ypri";
import type { RuotaSettori } from "./sorgente";

/**
 * Kit settori per trasportatori a catena, ricostruiti dai file generali:
 * - Spare Parts List, foglio "KIT SETTORI": un blocco per kit (KIT SETTORI Z=10 P=260) con
 *   il settore (quantità, codice, CODICE D.B. = codice del kit) e la bulloneria;
 * - Spare Parts List, foglio "Listino-Codici": descrizione di vendita di ogni codice;
 * - foglio "CDC-CTM - PREZZI OFF." del template offerta: codice disegno degli articoli.
 * Il lato comando usa i settori Z, il lato rinvio i settori R.
 */

export interface KitComponente {
  code: string;
  descrizione: string;
  qty: number;
  disegno: string;
}

export interface KitSettori {
  code: string;
  descrizione: string;
  /** Settori contenuti in un kit. */
  settoriPerKit: number;
  componenti: KitComponente[];
}

interface Catalogo {
  stamp: string;
  descrizioni: Map<string, string>;
  disegni: Map<string, string>;
  /** Blocchi del foglio KIT SETTORI, per codice kit. */
  blocchi: Map<string, { settoreCode: string; settoreDesc: string; settori: number; bulloneria: KitComponente[] }>;
}

let cache: Catalogo | null = null;

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
}

function rowsOf(wb: XLSX.WorkBook, sheet: string): string[][] {
  const ws = wb.Sheets[sheet];
  if (!ws) return [];
  return XLSX.utils
    .sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" })
    .map((row) => row.map(str));
}

function fileStamp(file: string | null): string {
  if (!file) return "-";
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "-";
  }
}

function findDoc(test: (name: string, kind: string) => boolean): string | null {
  const doc = listDocumenti().find((item) => test(item.name, item.kind));
  if (!doc) return null;
  try {
    return resolveDocumento(doc.path);
  } catch {
    return null;
  }
}

function readSpareList(file: string, out: Catalogo) {
  const wb = XLSX.readFile(file, { sheets: ["Listino-Codici", "KIT SETTORI"] });

  for (const row of rowsOf(wb, "Listino-Codici")) {
    const code = row[3];
    const desc = row[4];
    if (code && desc && !/^codice$/i.test(code)) out.descrizioni.set(code.toUpperCase(), desc);
  }

  // Colonne del foglio KIT SETTORI dalla riga d'intestazione MATERIALE | Q.TA' | DISEGNO | CODICE | CODICE D.B.
  const rows = rowsOf(wb, "KIT SETTORI");
  let cols: { desc: number; qty: number; draw: number; code: number; kit: number } | null = null;
  let current: { kit: string; settori: number; settoreCode: string; settoreDesc: string; bulloneria: KitComponente[] } | null = null;
  const close = () => {
    if (current?.kit) {
      out.blocchi.set(current.kit.toUpperCase(), {
        settoreCode: current.settoreCode,
        settoreDesc: current.settoreDesc,
        settori: current.settori,
        bulloneria: current.bulloneria,
      });
    }
    current = null;
  };
  for (const row of rows) {
    const first = row[0] ?? "";
    if (/^kit\s+settori\b/i.test(first)) {
      close();
      continue;
    }
    if (/^materiale$/i.test(first)) {
      const at = (re: RegExp) => row.findIndex((value) => re.test(value));
      cols = {
        desc: 0,
        qty: at(/^q\.?\s*t[aà]/i),
        draw: at(/^disegno$/i),
        code: at(/^codice$/i),
        kit: at(/^codice\s+d\.?\s*b\.?$/i),
      };
      continue;
    }
    if (!cols || cols.code < 0 || !first) continue;
    const code = row[cols.code] ?? "";
    const qty = Number((row[cols.qty] ?? "").replace(",", "."));
    if (!code || !Number.isFinite(qty) || qty <= 0) continue;
    if (/^settore\b|^sett\b/i.test(first) && cols.kit >= 0 && row[cols.kit]) {
      close();
      current = { kit: row[cols.kit], settori: qty, settoreCode: code, settoreDesc: first, bulloneria: [] };
      continue;
    }
    current?.bulloneria.push({
      code,
      descrizione: first,
      qty,
      disegno: cols.draw >= 0 ? row[cols.draw] ?? "" : "",
    });
  }
  close();
}

function readDrawings(file: string, out: Catalogo) {
  const sheet = "CDC-CTM - PREZZI OFF.";
  const wb = XLSX.readFile(file, { sheets: [sheet] });
  const rows = rowsOf(wb, sheet);
  let colArt = -1;
  let colDraw = -1;
  for (const row of rows.slice(0, 15)) {
    const art = row.findIndex((value) => /^articolo/i.test(value));
    const draw = row.findIndex((value) => /^cod\.?\s*disegno$/i.test(value));
    if (art >= 0 && draw >= 0) {
      colArt = art;
      colDraw = draw;
      break;
    }
  }
  if (colArt < 0) return;
  for (const row of rows) {
    const art = (row[colArt] ?? "").toUpperCase();
    const draw = row[colDraw] ?? "";
    if (art && /[A-Z0-9]{3,}/i.test(draw) && !out.disegni.has(art)) out.disegni.set(art, draw);
  }
}

function catalogo(): Catalogo {
  const spare = findDoc((name, kind) => kind === "spare-part-list" || /spare\s*parts?\s*list/i.test(name));
  const template = findDoc((name) => /template\s+offerta/i.test(name) && /\.xls[xm]?$/i.test(name));
  const stamp = `${fileStamp(spare)}|${fileStamp(template)}`;
  if (cache?.stamp === stamp) return cache;
  const out: Catalogo = { stamp, descrizioni: new Map(), disegni: new Map(), blocchi: new Map() };
  if (spare) {
    try {
      readSpareList(spare, out);
    } catch {
      // Spare Parts List illeggibile: nessun kit dal catalogo.
    }
  }
  if (template) {
    try {
      readDrawings(template, out);
    } catch {
      // Template senza foglio costi: nessun disegno.
    }
  }
  cache = out;
  return out;
}

/** Descrizione di vendita dal foglio Listino-Codici della Spare Parts List. */
export function descrizioneListino(code: string): string {
  return catalogo().descrizioni.get(code.toUpperCase()) ?? "";
}

function inListino(code: string): boolean {
  return priceArticle(code).found;
}

function disegnoDi(cat: Catalogo, code: string): string {
  const upper = code.toUpperCase();
  return cat.disegni.get(upper) ?? cat.disegni.get(upper.replace(/-V$/, "")) ?? "";
}

/**
 * Kit settori per una ruota della distinta: KIT-SET-{Z|R}{z}-P{passo}.
 * Componenti: il settore verniciato SETTORE-{Z|R}{z}-P{passo}-V se è a listino (altrimenti quello
 * del foglio KIT SETTORI) e il kit bulloneria KB-… se è a listino (altrimenti viti, rondelle e dadi del foglio).
 */
export function kitPerRuota(ruota: RuotaSettori, passo: string): KitSettori | null {
  if (!passo) return null;
  const cat = catalogo();
  const lato = ruota.lato === "comando" ? "Z" : "R";
  const z = String(ruota.z).padStart(2, "0");
  const code = `KIT-SET-${lato}${z}-P${passo}`;
  const blocco = cat.blocchi.get(code);
  const descrizione = descrizioneListino(code);
  if (!blocco && !descrizione && !inListino(code)) return null;

  const settoriPerKit = blocco?.settori ?? 4;
  const settoreStd = `SETTORE-${lato}${z}-P${passo}-V`;
  const settoreCode = inListino(settoreStd) ? settoreStd : blocco?.settoreCode ?? settoreStd;
  const componenti: KitComponente[] = [
    {
      code: settoreCode,
      descrizione:
        descrizioneListino(settoreCode) ||
        (settoreCode === blocco?.settoreCode ? blocco.settoreDesc : "") ||
        `SETTORE ${lato}=${z} P${passo} VERNICIATO`,
      qty: settoriPerKit,
      disegno: disegnoDi(cat, settoreCode),
    },
  ];

  const zz = String(ruota.z);
  const kitBulloni = [
    `KB-Z${zz}/R${zz}-P${passo}`,
    `KB-Z${z}/R${z}-P${passo}`,
    `KB-${lato}${zz}-P${passo}`,
    `KB-${lato}${z}-P${passo}`,
  ].find(inListino);
  if (kitBulloni) {
    componenti.push({
      code: kitBulloni,
      descrizione:
        descrizioneListino(kitBulloni) ||
        `KIT BULLONERIA FISSAGGIO SETTORI ${kitBulloni.replace(/^KB-/, "").replace(/-P(\d+)$/, " P=$1").replace(/([ZR])(\d+)/g, "$1=$2")}`,
      qty: 1,
      disegno: disegnoDi(cat, kitBulloni),
    });
  } else if (blocco) {
    componenti.push(...blocco.bulloneria.map((item) => ({ ...item, disegno: item.disegno || disegnoDi(cat, item.code) })));
  }

  return {
    code,
    descrizione: descrizione || `KIT SETTORI ${lato}=${z} P${passo} COMPLETI DI BULLONERIA NR ${settoriPerKit} SETTORI`,
    settoriPerKit,
    componenti,
  };
}
