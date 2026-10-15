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

export interface BuildOfferOptions {
  restrictPaths?: string[];
}

function mapBomFiles(docs: DocumentoFile[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const d of docs) {
    if (d.kind !== "distinta") continue;
    if (!/\.(xlsx|xlsm|xls)$/i.test(d.name)) continue;
    const fromName = d.name.match(/BE\d{4}/i)?.[0];
    const base = (d.code || fromName || "").toUpperCase();
    if (!/^BE\d{4}$/.test(base)) continue;
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
  indices: SpareIndexRow[]
): { row: SpareIndexRow; token: string; family: string } | null {
  let best: {
    row: SpareIndexRow;
    token: string;
    family: string;
    len: number;
    specificity: number;
  } | null = null;
  for (const row of indices) {
    const tokens = indexTokens(row.indice);
    for (const token of tokens) {
      if (!tokenInDescription(desc, token)) continue;
      if (isUcfAccessoryMention(desc, token)) continue;
      const specificity = token.length * 100 - tokens.length;
      if (!best || specificity > best.specificity) {
        best = {
          row,
          token,
          family: familyToken(desc, token),
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
    const skipSigla = opts.skipSigla || row.source === "config";
    if (!skipSigla && !isSparePartCode(pn)) continue;
    const desc = bomDescription(row);
    const m = matchIndex(desc, indices);
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
 *  - filtro 2: descrizione che contiene un indice della tabella
 *  - codici univoci; listino se Spare Parts List = SI, altrimenti codice distinta
 *  - Composto: accorpa le istanze (es. body/ringer TM100CLC → descrizione da struttura)
 *  - + gruppo cuscinetti: sotto l'assieme, cuscinetti gialli della scheda listino
 *  - poi motori (ML, solo codice MR…) e sensori (SL)
 */
export async function buildSparePartsOffer(
  opts: BuildOfferOptions = {}
): Promise<Offer> {
  await prepareApp();
  const docs = await listDocumentiClassificati();
  const pdfDoc =
    docs
      .filter((d) => d.kind === "ordine")
      .sort((a, b) => b.modified.localeCompare(a.modified))[0] ??
    docs.find((d) => d.ext === ".pdf" && d.kind !== "template");
  const mlDoc =
    docs.find((d) => d.kind === "lista-motori") ??
    docs.find((d) => /-ML\.xlsx$/i.test(d.name));
  const slDoc =
    docs.find((d) => d.kind === "lista-sensori") ??
    docs.find((d) => /-SL\.xlsx$/i.test(d.name));
  const splDoc =
    docs.find((d) => d.kind === "listino") ??
    docs.find((d) => /spare\s*parts?\s*list/i.test(d.name));

  if (!pdfDoc) {
    throw new Error("Documento d'ordine PDF non trovato nella cartella documenti.");
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

  const order = await parseOrderPdf(resolveDocumento(pdfDoc.path));
  const motorsByBase: Map<string, ProposalLine[]> = mlDoc
    ? groupByJobBase(parseMotorList(resolveDocumento(mlDoc.path)))
    : new Map();
  const sensorsByBase: Map<string, ProposalLine[]> = slDoc
    ? groupByJobBase(parseSensorList(resolveDocumento(slDoc.path)))
    : new Map();

  const bomFiles = mapBomFiles(docs);
  let restrictBases: Set<string> | undefined;
  if (opts.restrictPaths && opts.restrictPaths.length > 0) {
    restrictBases = new Set(
      opts.restrictPaths
        .map((p) => p.match(/^BE\d{4}/i)?.[0]?.toUpperCase())
        .filter((x): x is string => Boolean(x))
    );
  }

  const machines: MachineSection[] = [];

  for (const item of order.includedItems) {
    const base = item.code.toUpperCase();
    if (restrictBases && !restrictBases.has(base)) continue;
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

    for (const g of groups) {
      const res = linesFromGroup(g, spareMap, catalog);
      const grouped =
        isComposto(g[0].indexRow.gestione) ||
        res.lines.some((l) => l.highlightGroup === "cuscinetti");
      if (grouped) {
        for (const l of res.lines) l.compoundHue = compoundHue;
        compoundHue += 1;
      }
      spares.push(...res.lines);
      warnings.push(...res.warnings);
    }

    const section: MachineSection = {
      itemCode: base,
      jobNr: parsed.header.jobNr,
      layoutPosition: parsed.header.layoutPosition,
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
      motorListFile: mlDoc?.name,
      sensorListFile: slDoc?.name,
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
