import fs from "node:fs";
import ExcelJS from "exceljs";

/** Componente giallo della scheda listino (cuscinetto, ralla, tenuta, …). */
export interface CatalogBearing {
  code: string;
  description: string;
  qty: number;
}

interface AssemblyInfo {
  code: string;
  description?: string;
}

export interface SpareCatalog {
  /** TM100CLC → SUP-TM100-CLC */
  assemblyByKey: Map<string, AssemblyInfo>;
  /** C003577-A → SUP-TM100-CLC */
  assemblyByBom: Map<string, AssemblyInfo>;
  /** TM100CLC → cuscinetti gialli della scheda */
  bearingsByKey: Map<string, CatalogBearing[]>;
  /** C003577-A → cuscinetti della stessa scheda */
  bearingsByBom: Map<string, CatalogBearing[]>;
  /** SUP-SNH-520-ISB → cuscinetti della riga */
  bearingsBySellable: Map<string, CatalogBearing[]>;
}

let cache: { key: string; catalog: SpareCatalog } | null = null;

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function normKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * In distinta i supporti sono SNL; nel listino stanno sotto SNH.
 * Restituisce la chiave originale e il gemello SNL↔SNH.
 */
export function snlSnhVariants(s: string): string[] {
  const u = s.toUpperCase();
  const out = new Set([u]);
  if (u.includes("SNL")) out.add(u.replace(/SNL/g, "SNH"));
  if (u.includes("SNH")) out.add(u.replace(/SNH/g, "SNL"));
  return [...out];
}

/** Lookup su mappa listino, con alias SNL↔SNH e match per modello (SNL520 ⊂ SNH520ISB). */
export function catalogLookup<T>(
  map: Map<string, T>,
  key: string
): T | undefined {
  const variants = snlSnhVariants(key);
  for (const k of variants) {
    const v = map.get(k);
    if (v !== undefined) return v;
  }
  const withModel = variants.filter((k) => k.length >= 5 && /\d/.test(k));
  if (!withModel.length) return undefined;
  for (const [mk, val] of map) {
    if (
      withModel.some((k) => {
        const longer = mk.length >= k.length ? mk : k;
        const shorter = mk.length >= k.length ? k : mk;
        return shorter.length >= 5 && /\d/.test(shorter) && longer.includes(shorter);
      })
    ) {
      return val;
    }
  }
  return undefined;
}

function argbOf(fill: ExcelJS.Fill | undefined): string | undefined {
  if (!fill || fill.type !== "pattern") return undefined;
  const fg = (fill as ExcelJS.FillPattern).fgColor;
  const argb = fg?.argb;
  return typeof argb === "string" ? argb : undefined;
}

/** Giallo "codici vendita" del listino (FFFF00 / FFFFCxxx). */
export function isYellowFill(fill: ExcelJS.Fill | undefined): boolean {
  const argb = argbOf(fill);
  if (!argb || argb.length < 6) return false;
  const rgb = argb.slice(-6);
  const r = parseInt(rgb.slice(0, 2), 16);
  const g = parseInt(rgb.slice(2, 4), 16);
  const b = parseInt(rgb.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return false;
  return r >= 200 && g >= 170 && b <= 170;
}

function looksLikeCode(s: string): boolean {
  if (!s || s.length < 3 || s.length > 40) return false;
  if (/\s{2,}/.test(s)) return false;
  return /[A-Z]/i.test(s) && /[0-9]/.test(s);
}

function isBearingDesc(desc: string, code: string): boolean {
  const d = desc.toLowerCase();
  const c = code.toUpperCase();
  if (/^CUS-/.test(c) || /^RALLA-/.test(c) || /^CU\d/.test(c)) return true;
  return /cuscinett|bearing|ralla/.test(d);
}

function isAssemblyCode(code: string): boolean {
  const c = code.trim().toUpperCase();
  return /^(SUP-|KIT-|TKK-SUP-|TK-SUP-)/i.test(c);
}

/**
 * Pezzi gialli da mettere sotto l'assieme (TM, SN, TKK, TK-R, …).
 * Esclusi: codice assieme (SUP-/KIT-/TKK-SUP-/TK-SUP-) e kit "supporto + bulloneria" (…-S).
 */
function isYellowGroupPart(code: string): boolean {
  const c = code.trim().toUpperCase();
  if (!looksLikeCode(c)) return false;
  if (isAssemblyCode(c)) return false;
  if (/[-.]S$/.test(c)) return false;
  return true;
}

/** D135 in distinta = scheda listino TKK Ø=135; TK-R 70 = SUPPORTO TK-R70. */
function supportAliases(sheetName: string): string[] {
  const key = normKey(sheetName);
  const out = new Set<string>([key]);
  const tkk = sheetName.match(/TKK[^0-9]*(\d+)/i);
  if (tkk) {
    out.add(normKey(`D${tkk[1]}`));
    out.add(normKey(`TKK${tkk[1]}`));
    out.add(normKey(`TKKSUP${tkk[1]}`));
  }
  const tkr = sheetName.match(/TK-?R[^0-9]*(\d+)/i);
  if (tkr) {
    out.add(normKey(`TKR${tkr[1]}`));
    out.add(normKey(`TK-R${tkr[1]}`));
  }
  return [...out].filter(Boolean);
}

function emptyCatalog(): SpareCatalog {
  return {
    assemblyByKey: new Map(),
    assemblyByBom: new Map(),
    bearingsByKey: new Map(),
    bearingsByBom: new Map(),
    bearingsBySellable: new Map(),
  };
}

function addBearings(map: Map<string, CatalogBearing[]>, key: string, items: CatalogBearing[]) {
  if (!key || !items.length) return;
  const k = key.toUpperCase();
  const prev = map.get(k) ?? [];
  const seen = new Set(prev.map((b) => b.code.toUpperCase()));
  const merged = [...prev];
  for (const it of items) {
    if (seen.has(it.code.toUpperCase())) continue;
    seen.add(it.code.toUpperCase());
    merged.push(it);
  }
  map.set(k, merged);
}

async function buildCatalog(filePath: string): Promise<SpareCatalog> {
  const catalog = emptyCatalog();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  for (const ws of wb.worksheets) {
    const key = normKey(ws.name);
    if (!key) continue;

    const maxRow = Math.min(ws.rowCount || 0, 200);
    const maxCol = Math.min(ws.columnCount || 0, 20);
    if (maxRow < 5) continue;

    // Header row detection
    let headerRow = -1;
    let colDisegno = -1;
    let colCodice = -1;
    let colOggetto = -1;
    let colQty = -1;
    for (let r = 1; r <= Math.min(maxRow, 45); r++) {
      const labels: string[] = [];
      for (let c = 1; c <= maxCol; c++) {
        labels[c] = cellStr(ws.getRow(r).getCell(c).value).toLowerCase();
      }
      const d = labels.findIndex((x) =>
        ["disegno", "codice d.b.", "codice db"].includes(x ?? "")
      );
      const k = labels.findIndex((x) => x === "codice" || x === "code");
      if (k > 0) {
        headerRow = r;
        colCodice = k;
        colDisegno = d > 0 ? d : -1;
        colOggetto = labels.findIndex((x) =>
          ["oggetto", "materiale", "descrizione", "description"].includes(x ?? "")
        );
        colQty = labels.findIndex((x) => {
          const v = x ?? "";
          return v.includes("q.ta") || v === "qty" || v === "q.ty";
        });
        break;
      }
    }

    // Matrix bearing house (SUPPORTI SNH): header has Bearing + CODE
    let supportCodeCol = -1;
    let supportNameCol = 1;
    for (let r = 1; r <= Math.min(maxRow, 50); r++) {
      const labels: string[] = [];
      for (let c = 1; c <= maxCol; c++) {
        labels[c] = cellStr(ws.getRow(r).getCell(c).value).toLowerCase();
      }
      const bIdx = labels.findIndex((x) => x === "bearing");
      const codeIdxs = labels
        .map((x, i) => (x === "code" || x === "codice" ? i : -1))
        .filter((i) => i > 0);
      if (bIdx > 0 && codeIdxs.length >= 2) {
        supportNameCol = 1;
        supportCodeCol = codeIdxs[0];
        for (let rr = r + 1; rr <= maxRow; rr++) {
          const row = ws.getRow(rr);
          const sell = cellStr(row.getCell(supportCodeCol).value);
          const name = cellStr(row.getCell(supportNameCol).value);
          if (!sell && !name) continue;
          const bearings: CatalogBearing[] = [];
          for (const codeIdx of codeIdxs) {
            const part = cellStr(row.getCell(codeIdx).value);
            if (!part || !isYellowFill(row.getCell(codeIdx).fill)) continue;
            if (!isYellowGroupPart(part)) continue;
            const partDesc = cellStr(row.getCell(codeIdx - 1).value);
            bearings.push({ code: part, description: partDesc || part, qty: 1 });
          }
          if (sell) {
            addBearings(catalog.bearingsBySellable, sell, bearings);
            const info = { code: sell, description: name };
            const nameKey = normKey(name || sell);
            catalog.assemblyByKey.set(nameKey, info);
            const modelKey = normKey((name || "").replace(/\+.*$/, ""));
            if (modelKey && modelKey !== nameKey) {
              catalog.assemblyByKey.set(modelKey, info);
            }
          }
        }
        break;
      }
    }

    if (headerRow < 0 || colCodice < 0) continue;

    const sheetBearings: CatalogBearing[] = [];
    const sheetBoms: string[] = [];
    let assembly: AssemblyInfo | undefined;
    let assemblyWithBolts: AssemblyInfo | undefined;

    for (let r = headerRow + 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      const codice = cellStr(row.getCell(colCodice).value);
      const disegno = colDisegno > 0 ? cellStr(row.getCell(colDisegno).value) : "";
      const oggetto = colOggetto > 0 ? cellStr(row.getCell(colOggetto).value) : "";
      const qtyRaw = colQty > 0 ? row.getCell(colQty).value : 1;
      const qty = typeof qtyRaw === "number" ? qtyRaw : Number(qtyRaw) || 1;
      const yellow = isYellowFill(row.getCell(colCodice).fill);

      if (disegno && looksLikeCode(disegno)) sheetBoms.push(disegno.toUpperCase());
      if (codice && looksLikeCode(codice) && isAssemblyCode(codice)) {
        const info = { code: codice, description: oggetto || codice };
        if (/[-.]S$/i.test(codice) || /bulloner/i.test(oggetto)) {
          assemblyWithBolts = info;
        } else if (!assembly) {
          assembly = info;
        }
      }
      if (codice && yellow && isYellowGroupPart(codice)) {
        sheetBearings.push({ code: codice, description: oggetto || codice, qty });
      }
    }

    if (!assembly) {
      for (let r = Math.max(1, headerRow - 4); r < headerRow; r++) {
        const row = ws.getRow(r);
        let blob = "";
        let yellowCode = "";
        for (let c = 1; c <= maxCol; c++) {
          const text = cellStr(row.getCell(c).value);
          if (text) blob += ` ${text}`;
          if (!yellowCode && looksLikeCode(text) && isYellowFill(row.getCell(c).fill)) {
            yellowCode = text;
          }
        }
        if (yellowCode && /supporto completo/i.test(blob)) {
          assembly = { code: yellowCode, description: yellowCode };
          break;
        }
      }
    }

    const sheetKey = normKey(ws.name);
    const isTkSupport = /^SUPPORTOTK/.test(sheetKey);
    const picked = isTkSupport
      ? assemblyWithBolts || assembly
      : assembly || assemblyWithBolts;
    const aliasKeys = supportAliases(ws.name);

    if (picked) {
      for (const k of aliasKeys) catalog.assemblyByKey.set(k, picked);
      for (const bom of sheetBoms) {
        if (!catalog.assemblyByBom.has(bom)) catalog.assemblyByBom.set(bom, picked);
      }
    }
    if (sheetBearings.length) {
      for (const k of aliasKeys) addBearings(catalog.bearingsByKey, k, sheetBearings);
      for (const bom of sheetBoms) addBearings(catalog.bearingsByBom, bom, sheetBearings);
      if (picked) addBearings(catalog.bearingsBySellable, picked.code, sheetBearings);
    }

    indexChainSheet(catalog, ws.name, headerRow, colCodice, colOggetto, ws, maxRow);
  }

  return catalog;
}

/** Catene di trasporto TKK: 14226MN → CT0067 (e varianti TRASPORTCHAIN…). */
function indexChainSheet(
  catalog: SpareCatalog,
  sheetName: string,
  headerRow: number,
  colCodice: number,
  colOggetto: number,
  ws: ExcelJS.Worksheet,
  maxRow: number
) {
  if (!/catene\s*di\s*trasporto\s*tkk/i.test(sheetName)) return;
  const maxCol = Math.min(ws.columnCount || 0, 8);
  for (let r = headerRow + 1; r <= maxRow; r++) {
    const row = ws.getRow(r);
    const codice = cellStr(row.getCell(colCodice).value);
    if (!/^CT\d+/i.test(codice)) continue;
    const texts: string[] = [];
    for (let c = 1; c <= maxCol; c++) texts.push(cellStr(row.getCell(c).value));
    const blob = texts.join(" ");
    const typeM = blob.match(/(\d{4,})\s*(MN|CN)/i);
    if (!typeM) continue;
    const stdPitch = /5\s*X\s*142/i.test(blob);
    if (!stdPitch) continue;
    const typeKey = normKey(`${typeM[1]}${typeM[2]}`);
    if (catalog.assemblyByKey.has(typeKey)) continue;
    const info = { code: codice, description: blob };
    catalog.assemblyByKey.set(typeKey, info);
    catalog.assemblyByKey.set(normKey(`TRASPORTCHAIN${typeM[1]}`), info);
    catalog.assemblyByKey.set(normKey(`TRASPORTCHAIN${typeM[1]}${typeM[2]}`), info);
    catalog.assemblyByBom.set(codice.toUpperCase(), info);
  }
}

export async function getSpareCatalog(filePath: string): Promise<SpareCatalog> {
  let mtime = 0;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return emptyCatalog();
  }
  const cacheKey = `${filePath}:${mtime}`;
  if (cache && cache.key === cacheKey) return cache.catalog;
  const catalog = await buildCatalog(filePath);
  cache = { key: cacheKey, catalog };
  return catalog;
}
