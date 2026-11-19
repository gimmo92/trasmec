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
  /** Listino-Codici: tipologia di ogni codice (es. C003369 → TM 75 CLC) e codici per tipologia. */
  tipologie: Map<string, string>;
  perTipologia: Map<string, string[]>;
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
    if (code && desc && !/^codice$/i.test(code)) {
      const key = code.toUpperCase();
      out.descrizioni.set(key, desc);
      const tipologia = (row[2] ?? "").replace(/\s+/g, "").toUpperCase();
      if (tipologia) {
        out.tipologie.set(key, tipologia);
        out.perTipologia.set(tipologia, [...(out.perTipologia.get(tipologia) ?? []), key]);
      }
    }
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
  const out: Catalogo = {
    stamp,
    descrizioni: new Map(),
    tipologie: new Map(),
    perTipologia: new Map(),
    disegni: new Map(),
    blocchi: new Map(),
  };
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

/** KIT-SET-Z10-P142 → kit con i suoi componenti (stesse regole di kitPerRuota). */
export function kitDaCodice(code: string): KitSettori | null {
  const spec = code.toUpperCase().match(/^KIT-SET-([ZR])(\d+)-P(\d+)$/);
  if (!spec) return null;
  const blocco = catalogo().blocchi.get(code.toUpperCase());
  return kitPerRuota(
    { lato: spec[1] === "Z" ? "comando" : "rinvio", z: Number(spec[2]), settori: blocco?.settori ?? 4 },
    spec[3]
  );
}

/**
 * Prezzo unitario di un kit settori che nel listino YPRI vale 0: somma dei componenti
 * (prezzo listino × CTM × maggiorazione, per il cliente se indicato). Null se manca un componente.
 */
export function prezzoKit(code: string, customerCode?: string): number | null {
  const kit = kitDaCodice(code);
  if (!kit) return null;
  let somma = 0;
  for (const comp of kit.componenti) {
    const result = priceArticle(comp.code, customerCode);
    if (!result.found || result.unitPrice <= 0) return null;
    somma += result.unitPrice * comp.qty;
  }
  return Math.round(somma * 100) / 100;
}

/** Percorso della Spare Parts List in archivio. */
export function spareListPath(): string | null {
  return findDoc((name, kind) => kind === "spare-part-list" || /spare\s*parts?\s*list/i.test(name));
}

/** Assieme di listino con i componenti gialli della sua scheda (es. supporto + cuscinetti e tenute). */
export interface AssiemeListino {
  code: string;
  descrizione: string;
  componenti: KitComponente[];
}

/**
 * Pezzo richiesto senza distinta: codice Trasmec (C003369) o modello (TM 75 CLC) cercati nella
 * Spare Parts List, con la stessa regola dell'offerta impianto: assieme giallo della scheda
 * (C003369-S) e sotto i cuscinetti/tenute gialli. Se il cliente cita un codice di listino,
 * la riga principale è quel codice.
 */
export async function assiemeDaListino(text: string): Promise<AssiemeListino | null> {
  const file = spareListPath();
  if (!file) return null;
  const upper = text.toUpperCase();
  const codes = [...new Set(upper.match(/\b[A-Z]{1,6}\d{3,}(?:-[A-Z0-9]+)*\b/g) ?? [])];
  const model = upper.match(/\bTM\s*(\d{2,3})\s*(CLC|CLS|2RP|V\s*LOC|LOC|V)\b/);
  const family = model ? `TM${model[1]}${model[2].replace(/\s+/g, "")}` : "";

  const { getSpareCatalog, catalogLookup, normKey } = await import("./sparecatalog");
  const catalog = await getSpareCatalog(file);
  const listed = codes.find((code) => descrizioneListino(code));
  const keys = [...codes, ...(listed ? [listed] : [])];
  const assembly =
    keys.map((code) => catalogLookup(catalog.assemblyByBom, code)).find(Boolean) ??
    (family ? catalogLookup(catalog.assemblyByKey, normKey(family)) : undefined) ??
    keys.map((code) => catalogLookup(catalog.assemblyByKey, normKey(code))).find(Boolean);
  const bearings =
    keys.map((code) => catalogLookup(catalog.bearingsByBom, code)).find((list) => list?.length) ??
    (family ? catalogLookup(catalog.bearingsByKey, normKey(family)) : undefined) ??
    [];

  // Supporto richiesto per modello: la riga principale è il codice "completo di cuscinetti"
  // della stessa tipologia (C003369), sotto il supporto con bulloneria (-S) e i cuscinetti gialli.
  const cat = catalogo();
  const tipologia =
    family ||
    (listed ? cat.tipologie.get(listed.toUpperCase()) : undefined) ||
    (assembly?.code ? cat.tipologie.get(assembly.code.toUpperCase()) : undefined) ||
    "";
  const completo = (cat.perTipologia.get(tipologia) ?? []).find((code) =>
    /COMPLET[OA] DI CUSCINETTI/i.test(cat.descrizioni.get(code) ?? "")
  );
  const chiestoCompleto = listed && /COMPLET[OA] DI CUSCINETTI/i.test(descrizioneListino(listed));
  const main =
    (chiestoCompleto ? listed : undefined) ??
    (bearings.length ? completo : undefined) ??
    listed ??
    assembly?.code;
  if (!main) return null;
  const componenti: KitComponente[] = [];
  if (assembly?.code && assembly.code.toUpperCase() !== main.toUpperCase()) {
    componenti.push({
      code: assembly.code,
      descrizione: descrizioneListino(assembly.code) || assembly.description || assembly.code,
      qty: 1,
      disegno: "",
    });
  }
  for (const bearing of bearings) {
    if (bearing.code.toUpperCase() === main.toUpperCase()) continue;
    componenti.push({
      code: bearing.code,
      descrizione: descrizioneListino(bearing.code) || bearing.description,
      qty: bearing.qty || 1,
      disegno: "",
    });
  }
  return {
    code: main,
    descrizione: descrizioneListino(main) || assembly?.description || main,
    componenti,
  };
}
