import type { BomRow, DocumentoFile, MachineSection, Offer, ProposalLine, SpareIndexRow } from "./types";
import { listDocumentiClassificati, resolveDocumento } from "./documenti";
import { parseBomForOffer, parseNum, recommendedFromInstalled, isSparePartCode } from "./excel";
import { parseMotorList, parseSensorList, groupByJobBase } from "./motorsensor";
import { parseOrderPdf } from "./orderpdf";
import { getSpareCodeMap, type SpareCodeMap } from "./spareindex";
import { listIndici } from "./indici";
import {
  getSpareCatalog,
  catalogLookup,
  normKey,
  type CatalogBearing,
  type SpareCatalog,
} from "./sparecatalog";
import { refineOfferWithClaude } from "./claudeoffer";
import { prepareApp } from "./prepare";
import { isJobCode, jobCode } from "./jobcode";
import { readArchivio } from "./archivio";
import { readDrawings, type DrawingInfo } from "./disegni";

export interface BuildOfferOptions {
  /** File dell'ordine da cui generare. Obbligatorio. */
  orderPath?: string;
  restrictPaths?: string[];
}

function mapBomFiles(docs: DocumentoFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of docs) {
    if (d.kind !== "distinta") continue;
    if (!/\.(xlsx|xlsm|xls)$/i.test(d.name)) continue;
    const base = (d.code || jobCode(d.name) || "").toUpperCase();
    if (!isJobCode(base)) continue;
    if (!map.has(base)) map.set(base, d.name);
  }
  return map;
}

function isComposto(gestione: string): boolean {
  return /^composto/i.test(gestione.trim());
}

function hasCuscinetti(gestione: string): boolean {
  return /cuscinett/i.test(gestione);
}

function useSpareList(row: SpareIndexRow): boolean {
  return row.sparePartsList === "SI";
}

function indexTokens(indice: string): string[] {
  return indice
    .split(/[\s,;/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenInDescription(desc: string, token: string): boolean {
  if (!desc || !token) return false;
  if (/\s/.test(token)) return desc.toUpperCase().includes(token.toUpperCase());
  const re = new RegExp(
    `(^|[^A-Za-z0-9])(${escapeRe(token)}[A-Za-z0-9\\-]*)`,
    "gi"
  );
  for (const m of desc.matchAll(re)) {
    const word = m[2] || "";
    if (tokenAccepted(token, word)) return true;
  }
  return false;
}

/** Token corti (SN, TM, TP): evita falsi positivi tipo SNODO. Token lunghi: prefisso (SPAZ→SPAZZOLA). */
function tokenAccepted(token: string, word: string): boolean {
  const t = token.toUpperCase();
  const w = word.toUpperCase();
  if (!w.startsWith(t)) return false;
  if (w === t) return true;
  if (t.length >= 4) return true;
  if (/\d/.test(w)) return true;
  const extra = w.slice(t.length).replace(/-/g, "");
  return extra.length > 0 && extra.length <= 2 && /^[A-Z]+$/.test(extra);
}

function familyToken(desc: string, token: string): string {
  const chainType = desc.match(/(\d{4,})\s*(MN|CN)/i);
  if (chainType && /chain|trasport|convey/i.test(`${token} ${desc}`)) {
    return `${chainType[1]}${chainType[2]}`.toUpperCase();
  }
  // "SNL 520" / "Block SNL 520" → SNL520 (il numero è staccato in distinta)
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9])(${escapeRe(token)}[A-Za-z0-9\\-]*)(?:\\s+(\\d+))?`,
    "gi"
  );
  for (const m of desc.matchAll(re)) {
    const word = m[1] || "";
    if (!tokenAccepted(token, word)) continue;
    const size = m[2] || "";
    return `${word}${size}`.toUpperCase();
  }
  return token.toUpperCase();
}

function bomDescription(row: BomRow): string {
  return [row.descriptionEN, row.descriptionIT].filter(Boolean).join(" ");
}

/** UCF/UCFL nel testo di un carter/protezione non è il pezzo UCF. */
function isUcfAccessoryMention(desc: string, token: string): boolean {
  if (!/^UCF/i.test(token)) return false;
  return /carter|safety\s*guard|guardia|protezione|coperchio|cover\b/i.test(desc);
}

function matchIndex(
  desc: string,
  indices: SpareIndexRow[],
  partNumber = ""
): { row: SpareIndexRow; token: string; family: string } | null {
  let best: {
    row: SpareIndexRow;
    token: string;
    family: string;
    len: number;
    specificity: number;
  } | null = null;
  const pn = partNumber.trim().toUpperCase();
  for (const row of indices) {
    const tokens = indexTokens(row.indice);
    for (const token of tokens) {
      const onCode = pn.length > 0 && pn === token.toUpperCase();
      const inDesc = tokenInDescription(desc, token);
      if (!onCode && !inDesc) continue;
      if (!onCode && isUcfAccessoryMention(desc, token)) continue;
      if (
        /chain\s*coupling|giunto/i.test(desc) &&
        /^(CHAIN|TRASPORT|CONVEYING)$/i.test(token)
      ) {
        continue;
      }
      const specificity = (onCode ? 10000 : 0) + token.length * 100 - tokens.length;
      if (!best || specificity > best.specificity) {
        best = {
          row,
          token,
          family: inDesc ? familyToken(desc, token) : "",
          len: token.length,
          specificity,
        };
      }
    }
  }
  return best
    ? { row: best.row, token: best.token, family: best.family }
    : null;
}

function buildOfferDescription(
  indexRow: SpareIndexRow,
  family: string,
  fallback: string
): string {
  const tpl = indexRow.strutturaDescrizione.trim();
  const model = family || "";
  if (tpl) {
    if (/\{(modello|resto|model)\}/i.test(tpl)) {
      // "Chain CHAIN" non dice nulla: tieni il testo della scheda (es. "Chain - L=-").
      if (!model || /^(CHAIN|TRASPORT|CONVEYING|CATENA)$/i.test(model)) return fallback;
      return tpl
        .replace(/\{(modello|resto|model)\}/gi, model)
        .replace(/\s+/g, " ")
        .trim();
    }
    // Istruzione tipo "UCFL più numero" / `"Support" più nome … ad es "Support TM140CLC"`
    if (/più\s+(numero|nome)/i.test(tpl)) {
      const quoted = [...tpl.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const example = quoted.find((q) => /\d/.test(q));
      if (example && model) {
        const prefix = example.replace(/[A-Z0-9]+$/i, "").trim();
        return prefix && !model.toUpperCase().startsWith(prefix.toUpperCase())
          ? `${prefix} ${model}`.replace(/\s+/g, " ").trim()
          : model;
      }
      const prefix = tpl
        .replace(/più\s+(numero|nome).*$/i, "")
        .replace(/["']/g, "")
        .trim();
      if (model && prefix && model.toUpperCase().startsWith(prefix.toUpperCase())) {
        return model;
      }
      if (model && prefix) return `${prefix} ${model}`.replace(/\s+/g, " ").trim();
      return model || prefix || fallback;
    }
    if (model && !tpl.toUpperCase().includes(model.toUpperCase())) {
      return `${tpl} ${model}`.trim();
    }
    return tpl;
  }
  if (isComposto(indexRow.gestione)) {
    return [indexRow.descrizioneOfferta, model].filter(Boolean).join(" ");
  }
  return fallback;
}

function parentBomCode(code: string): string | undefined {
  const m = code.match(/^(.*)[-.][A-Z]$/i);
  return m ? m[1] : undefined;
}

function preferAssemblyCode(candidates: string[]): string | undefined {
  if (!candidates.length) return undefined;
  const tkBolts = candidates.find(
    (c) => /^(TKK-SUP-|TK-SUP-)/i.test(c) && /[-.]S$/i.test(c)
  );
  if (tkBolts) return tkBolts;
  const sup = candidates.find((c) =>
    /^(SUP-|KIT-|TKK-SUP-|TK-SUP-)/i.test(c)
  );
  if (sup) return sup;
  const notSuffix = candidates.find((c) => !/[-.][A-Z]$/i.test(c));
  return notSuffix || candidates[0];
}

function resolveSellable(
  pns: string[],
  family: string,
  map: SpareCodeMap,
  catalog: SpareCatalog,
  composto: boolean
): { code: string; bomCode?: string; mapped: boolean } {
  const bomCodes = pns.map((p) => p.trim()).filter(Boolean);
  const primary = bomCodes[0] || "";

  if (!composto) {
    const e = catalogLookup(map, primary.toUpperCase());
    if (e?.sellableCode && e.sellableCode.toUpperCase() !== primary.toUpperCase()) {
      return { code: e.sellableCode, bomCode: primary, mapped: true };
    }
    if (e?.sellableCode) return { code: e.sellableCode, mapped: true };
    const byFamily = catalogLookup(catalog.assemblyByKey, normKey(family));
    if (byFamily?.code) {
      return { code: byFamily.code, bomCode: primary, mapped: true };
    }
    return { code: primary, mapped: false };
  }

  const fromBom = bomCodes
    .map((c) => catalogLookup(catalog.assemblyByBom, c.toUpperCase())?.code)
    .filter((c): c is string => Boolean(c));
  const fromKey = catalogLookup(catalog.assemblyByKey, normKey(family))?.code;
  const fromMap: string[] = [];
  for (const c of bomCodes) {
    const e = catalogLookup(map, c.toUpperCase());
    if (e?.sellableCode) fromMap.push(e.sellableCode);
    const parent = parentBomCode(c);
    if (parent) {
      const pe = catalogLookup(map, parent.toUpperCase());
      if (pe?.sellableCode) fromMap.push(pe.sellableCode);
      const pa = catalogLookup(catalog.assemblyByBom, parent.toUpperCase())?.code;
      if (pa) fromBom.push(pa);
    }
  }

  const picked = preferAssemblyCode(
    [...fromBom, ...(fromKey ? [fromKey] : []), ...fromMap]
  );
  if (picked && picked.toUpperCase() !== primary.toUpperCase()) {
    return { code: picked, bomCode: primary, mapped: true };
  }
  if (picked) return { code: picked, mapped: true };
  return { code: primary, mapped: false };
}

function bearingsFor(
  pns: string[],
  family: string,
  sellable: string,
  catalog: SpareCatalog
): CatalogBearing[] {
  for (const c of pns) {
    const b = catalogLookup(catalog.bearingsByBom, c.toUpperCase());
    if (b?.length) return b;
    const parent = parentBomCode(c);
    if (parent) {
      const pb = catalogLookup(catalog.bearingsByBom, parent.toUpperCase());
      if (pb?.length) return pb;
    }
  }
  const bySell = catalogLookup(catalog.bearingsBySellable, sellable.toUpperCase());
  if (bySell?.length) return bySell;
  const byKey = catalogLookup(catalog.bearingsByKey, normKey(family));
  if (byKey?.length) return byKey;
  return [];
}

function toLine(opts: {
  code: string;
  bomCode?: string;
  mapped?: boolean;
  description: string;
  installed: number;
  notes?: string;
  um?: string;
  highlightGroup?: ProposalLine["highlightGroup"];
  noStorage?: boolean;
}): ProposalLine {
  return {
    code: opts.code,
    bomCode: opts.bomCode,
    mapped: opts.mapped,
    descriptionEN: opts.description,
    installedQty: opts.installed,
    recommendedQty: opts.noStorage ? null : recommendedFromInstalled(opts.installed),
    um: opts.um || "NR",
    category: "spare",
    notes: opts.notes,
    highlightGroup: opts.highlightGroup,
  };
}

interface Hit {
  pn: string;
  qty: number;
  desc: string;
  indexRow: SpareIndexRow;
  family: string;
  um?: string;
}

function uniqueHits(
  rows: BomRow[],
  indices: SpareIndexRow[],
  opts: { skipSigla?: boolean } = {}
): Hit[] {
  const acc = new Map<string, Hit>();
  for (const row of rows) {
    const pn = (row.partNumber ?? "").trim();
    if (!pn) continue;
    const skipSigla =
      opts.skipSigla || row.source === "config" || row.source === "scheda";
    if (!skipSigla && !isSparePartCode(pn)) continue;
    const desc = bomDescription(row);
    const m = matchIndex(desc, indices, pn);
    if (!m) continue;
    const qty = parseNum(row.qty) ?? 0;
    const prev = acc.get(pn);
    if (prev) {
      prev.qty += qty;
      continue;
    }
    acc.set(pn, {
      pn,
      qty,
      desc,
      indexRow: m.row,
      family: m.family,
      um: row.um,
    });
  }
  return [...acc.values()];
}

function compostoGroupKey(h: Hit): string {
  // TM100CLC resta distinto da TM140PCLC; SPAZZOLA/SPAZOZZA si accorpano tutti
  if (!/\d/.test(h.family)) return h.indexRow.id;
  return h.family;
}

function groupHits(hits: Hit[]): Hit[][] {
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const key = isComposto(h.indexRow.gestione)
      ? `${h.indexRow.id}::${compostoGroupKey(h)}`
      : `${h.indexRow.id}::u::${h.pn}`;
    const g = groups.get(key);
    if (g) g.push(h);
    else groups.set(key, [h]);
  }
  return [...groups.values()];
}

function linesFromGroup(
  group: Hit[],
  map: SpareCodeMap,
  catalog: SpareCatalog
): { lines: ProposalLine[]; warnings: string[] } {
  const warnings: string[] = [];
  const indexRow = group[0].indexRow;
  const family = group[0].family;
  const pns = group.map((h) => h.pn);
  const parent = group.find((h) => !/[-.][A-Z]$/i.test(h.pn));
  const installed = parent
    ? parent.qty
    : Math.max(...group.map((h) => h.qty), 0);
  const fallbackDesc = isComposto(indexRow.gestione)
    ? group.map((h) => h.desc).join(" / ")
    : group[0].desc;
  const description = buildOfferDescription(indexRow, family, fallbackDesc);

  const useList = useSpareList(indexRow);
  let code = group[0].pn;
  let bomCode: string | undefined;
  let mapped: boolean | undefined;

  if (useList) {
    const resolved = resolveSellable(
      pns,
      family,
      map,
      catalog,
      isComposto(indexRow.gestione)
    );
    code = resolved.code;
    bomCode = resolved.bomCode;
    mapped = resolved.mapped;
    if (!mapped) {
      warnings.push(
        `Codice listino non trovato per ${pns.join(", ")} (${indexRow.indice}): tenuto il codice distinta.`
      );
    }
  }

  const lines: ProposalLine[] = [
    toLine({
      code,
      bomCode,
      mapped,
      description,
      installed,
      notes: indexRow.indice,
      um: group.find((h) => h.um)?.um,
    }),
  ];

  if (hasCuscinetti(indexRow.gestione) && useList) {
    const brgs = bearingsFor(pns, family, code, catalog);
    if (!brgs.length) {
      warnings.push(
        `Gruppo cuscinetti non trovato nel listino per ${code} (${family}).`
      );
    } else {
      lines[0].highlightGroup = "cuscinetti";
      lines[0].recommendedQty = null;
    }
    for (const b of brgs) {
      const bQty = (b.qty || 1) * (installed || 1);
      lines.push(
        toLine({
          code: b.code,
          mapped: true,
          description: b.description,
          installed: bQty,
          notes: `cuscinetti ${code}`,
          highlightGroup: "cuscinetti",
        })
      );
    }
  }

  return { lines, warnings };
}

/**
 * Offerta ricambi:
 *  - item ordine dopo AFTER SALES → distinta
 *  - filtro 1: part number che inizia con una sigla (tab Sigle spare parts)
 *  - filtro 2: descrizione che contiene un indice, oppure part number uguale all'indice
 *  - codici univoci; listino se Spare Parts List = SI, altrimenti codice distinta
 *  - Composto: accorpa le istanze (es. body/ringer TM100CLC → descrizione da struttura)
 *  - + gruppo cuscinetti: sotto l'assieme, cuscinetti gialli della scheda listino
 *  - poi motori (ML, solo codice MR…) e sensori (SL)
 */
function fmt(value: number): string {
  return value.toLocaleString("it-IT", { maximumFractionDigits: 3 });
}

function setInstalled(line: ProposalLine, qty: number): void {
  line.installedQty = qty;
  if (line.recommendedQty !== null) line.recommendedQty = recommendedFromInstalled(qty);
}

/** 10% della metratura, arrotondato per eccesso a un numero intero di maglie. */
function chainStorage(installed: number, um: string, pitchMm: number): { qty: number; links: number } {
  const mm = /^mm$/i.test(um) ? installed : installed * 1000;
  const links = Math.max(1, Math.ceil((mm * 0.1) / pitchMm - 1e-9));
  const stock = links * pitchMm;
  return { qty: /^mm$/i.test(um) ? stock : Math.round(stock) / 1000, links };
}

/**
 * Catene in metri/millimetri: metratura dal "chain ring" del disegno della commessa,
 * scorta al passo maglia. Pale e scraper del disegno entrano con la quantità del disegno.
 */
function isScraperItem(code: string, description: string): boolean {
  return /^CT0003$/i.test(code) || /\b(scraper|scrap|pal[ae]|paddle)\b/i.test(`${code} ${description}`);
}

function applyDrawings(
  spares: ProposalLine[],
  warnings: string[],
  infos: DrawingInfo[],
  allowScrapers = true
): void {
  for (const info of infos) if (info.warning) warnings.push(`${info.file}: ${info.warning}`);

  const chainLines = spares.filter(
    (l) =>
      /chain|catena/i.test(`${l.descriptionEN ?? ""} ${l.descriptionIT ?? ""} ${l.notes ?? ""}`) &&
      /^(m|mt|mm)$/i.test((l.um ?? "").trim())
  );
  const ring = infos.find((i) => i.chainRing);
  if (chainLines.length && ring?.chainRing) {
    for (const line of chainLines) {
      const before = line.installedQty;
      const qty = /^mm$/i.test(line.um ?? "") ? ring.chainRing.meters * 1000 : ring.chainRing.meters;
      setInstalled(line, qty);
      warnings.push(
        `Catena ${line.code}: quantità installata dal disegno ${ring.file} (${ring.chainRing.text} = ${fmt(ring.chainRing.meters)} m), in distinta ${fmt(before)} ${line.um}.`
      );
    }
  } else if (chainLines.length && infos.length) {
    warnings.push(
      `Voce "chain ring" non trovata nel disegno (${infos.map((i) => i.file).join(", ")}): tenuta la metratura della distinta.`
    );
  }

  const drawingPitch = infos.find((i) => i.pitchMm);
  for (const line of chainLines) {
    const typePitch = Number(
      `${line.descriptionEN ?? ""} ${line.descriptionIT ?? ""}`.match(/\b(\d{3})\d{2}\s*MN\b/i)?.[1] ?? 0
    );
    const pitch = drawingPitch?.pitchMm ?? typePitch;
    if (!pitch) {
      warnings.push(`Catena ${line.code}: passo maglia non trovato, scorta al 10% arrotondata al metro.`);
      continue;
    }
    const stock = chainStorage(line.installedQty, line.um ?? "MT", pitch);
    line.recommendedQty = stock.qty;
    const from = drawingPitch ? `dal disegno ${drawingPitch.file}` : "dal tipo catena, non quotato nel disegno";
    warnings.push(
      `Catena ${line.code}: scorta ${fmt(stock.qty)} ${line.um} = 10% arrotondato a ${stock.links} maglie da ${fmt(pitch)} mm (passo ${from}).`
    );
  }

  const seen = new Set<string>();
  for (const info of infos) {
    for (const extra of info.extras) {
      const key = (extra.code || extra.description).toUpperCase();
      if (seen.has(key)) continue;
      if (!allowScrapers && isScraperItem(extra.code ?? "", extra.description)) continue;
      seen.add(key);
      const code = extra.code?.toUpperCase();
      const existing = code
        ? spares.find((l) => l.code.toUpperCase() === code || l.bomCode?.toUpperCase() === code)
        : undefined;
      if (existing) {
        if (existing.installedQty !== extra.qty) {
          warnings.push(
            `${existing.code}: quantità installata dal disegno ${info.file} (${fmt(extra.qty)}), in distinta ${fmt(existing.installedQty)}.`
          );
        }
        setInstalled(existing, extra.qty);
        continue;
      }
      spares.push(
        toLine({
          code: extra.code || "-",
          description: extra.description,
          installed: extra.qty,
          notes: "DISEGNO",
        })
      );
    }
  }
}

export async function buildSparePartsOffer(
  opts: BuildOfferOptions = {}
): Promise<Offer> {
  await prepareApp();
  const docs = await listDocumentiClassificati();
  if (!opts.orderPath) {
    throw new Error("Seleziona un'offerta prima di generarla.");
  }
  const pdfDoc = docs.find((d) => d.kind === "ordine" && (d.path === opts.orderPath || d.name === opts.orderPath));
  const splDoc =
    docs.find((d) => d.kind === "listino" && /spare\s*parts?\s*list/i.test(d.name)) ??
    docs.find((d) => /spare\s*parts?\s*list/i.test(d.name)) ??
    docs.find((d) => d.kind === "listino");

  if (!pdfDoc) {
    throw new Error("Offerta non trovata. Selezionala di nuovo dall'elenco.");
  }

  const { liste } = await readArchivio();
  const listeOrdine = liste.filter((file) => file.ordini.includes(pdfDoc.name));
  const mlDocs = listeOrdine.filter((file) => file.kind === "lista-motori");
  const slDocs = listeOrdine.filter((file) => file.kind === "lista-sensori");
  const offerWarnings: string[] = [];
  if (!mlDocs.length) offerWarnings.push("Nessuna lista motori associata a questa offerta: carica il file ML nell'Archivio.");
  if (!slDocs.length) offerWarnings.push("Nessuna lista sensori associata a questa offerta: carica il file SL nell'Archivio.");

  const order = await parseOrderPdf(resolveDocumento(pdfDoc.path));
  const bomFiles = mapBomFiles(docs);
  const orderCodes = order.includedItems.map((item) => item.code.toUpperCase());
  if (!orderCodes.length) {
    throw new Error(`Nell'offerta ${pdfDoc.name} non ho trovato item dopo AFTER SALES.`);
  }
  const found = orderCodes.filter((code) => bomFiles.has(code));
  if (!found.length) {
    throw new Error(
      `Nessuna distinta caricata per gli item dell'offerta (${orderCodes.join(", ")}). Caricale nell'Archivio.`
    );
  }

  let allowed = new Set(found);
  if (opts.restrictPaths && opts.restrictPaths.length > 0) {
    const byName = new Map(docs.map((d) => [d.name, d]));
    const picked = opts.restrictPaths
      .map((name) => (byName.get(name)?.code || jobCode(name) || "").toUpperCase())
      .filter((code) => allowed.has(code));
    if (picked.length) allowed = new Set(picked);
  }

  const indices = listIndici().filter((r) => r.indice.trim());
  if (!indices.length) {
    throw new Error("Tabella Indici dei ricambi vuota: aggiungi almeno un indice.");
  }

  const spareMap: SpareCodeMap = splDoc
    ? getSpareCodeMap(resolveDocumento(splDoc.path))
    : new Map();
  const catalog: SpareCatalog = splDoc
    ? await getSpareCatalog(resolveDocumento(splDoc.path))
    : {
        assemblyByKey: new Map(),
        assemblyByBom: new Map(),
        bearingsByKey: new Map(),
        bearingsByBom: new Map(),
        bearingsBySellable: new Map(),
      };

  const motorsByBase: Map<string, ProposalLine[]> = groupByJobBase(
    (
      await Promise.all(mlDocs.map((file) => parseMotorList(resolveDocumento(file.path))))
    ).flat()
  );
  const sensorsByBase: Map<string, ProposalLine[]> = groupByJobBase(
    (
      await Promise.all(slDocs.map((file) => parseSensorList(resolveDocumento(file.path))))
    ).flat()
  );

  // "TP" nel nome = scheda tappeto, non una catena
  const drawingDocs = docs.filter(
    (d) =>
      d.kind === "disegno" &&
      d.code &&
      allowed.has(d.code.toUpperCase()) &&
      !/(^|[^a-z])tp([^a-z]|$)/i.test(d.name)
  );
  const drawings = await readDrawings(
    drawingDocs.map((d) => ({ name: d.name, full: resolveDocumento(d.path) }))
  );

  const machines: MachineSection[] = [];

  for (const item of order.includedItems) {
    const base = item.code.toUpperCase();
    if (!allowed.has(base)) continue;
    const bomFile = bomFiles.get(base);
    if (!bomFile) continue;

    const parsed = parseBomForOffer(resolveDocumento(bomFile), bomFile);
    const hits = uniqueHits(parsed.bom, indices, {
      skipSigla: parsed.format === "config",
    });
    const groups = groupHits(hits);
    const spares: ProposalLine[] = [];
    const warnings = [...parsed.warnings];
    let compoundHue = 0;
    let supportHue = 0;

    for (const g of groups) {
      const res = linesFromGroup(g, spareMap, catalog);
      const isSupport = res.lines.some((l) => l.highlightGroup === "cuscinetti");
      const grouped = isComposto(g[0].indexRow.gestione) || isSupport;
      if (grouped) {
        const hue = isSupport ? supportHue : compoundHue;
        for (const l of res.lines) l.compoundHue = hue;
        if (isSupport) supportHue += 1;
        else compoundHue += 1;
      }
      spares.push(...res.lines);
      warnings.push(...res.warnings);
    }

    const doubleChain = parsed.bom.some((row) => /^CT\d+/i.test(String(row.partNumber ?? "")));
    applyDrawings(
      spares,
      warnings,
      drawingDocs
        .filter((d) => d.code?.toUpperCase() === base)
        .map((d) => drawings.get(d.name))
        .filter((info): info is DrawingInfo => Boolean(info)),
      parsed.format !== "config" || doubleChain
    );

    const section: MachineSection = {
      itemCode: base,
      jobNr: parsed.header.jobNr,
      layoutPosition: item.position || parsed.header.layoutPosition,
      machineType:
        parsed.header.sizeType || parsed.header.machineCode || undefined,
      description: item.description || parsed.header.description,
      atexConfig:
        parsed.header.atexConfig && /^[A-Za-z]/.test(parsed.header.atexConfig)
          ? parsed.header.atexConfig
          : undefined,
      bomFile,
      spares,
      motors: motorsByBase.get(base) ?? [],
      sensors: sensorsByBase.get(base) ?? [],
      warnings,
    };

    if (section.spares.length === 0) {
      section.warnings.push(
        "Nessun pezzo in distinta con un indice della tabella nella descrizione."
      );
    }

    machines.push(section);
  }

  const draft: Offer = {
    header: order.header,
    machines,
    meta: {
      orderFile: pdfDoc.name,
      motorListFiles: mlDocs.map((file) => file.name),
      sensorListFiles: slDocs.map((file) => file.name),
      warnings: offerWarnings,
      spareListFile: splDoc?.name,
      spareCodesIndexed: spareMap.size,
      afterSalesCode: order.afterSalesCode,
      includedFromOrder: order.includedItems.map((i) => i.code),
      machinesWithBom: machines.map((m) => m.itemCode),
      indiciUsed: indices.map((i) => i.indice),
    },
  };

  return refineOfferWithClaude(draft, indices);
}
