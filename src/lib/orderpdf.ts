import fs from "node:fs";
import { jobCodeRegex, jobCodes } from "./jobcode";
import type { OfferHeader } from "./types";

export interface OrderItem {
  code: string; // es. BE0805
  description?: string;
  /** Posizione di layout nel COC, es. "14.055" da "POS. 14.055". */
  position?: string;
}

export interface ParsedOrder {
  header: OfferHeader;
  allItems: string[]; // tutti i codici, in ordine
  afterSalesCode?: string; // codice dell'item "AFTER SALES"
  includedItems: OrderItem[]; // item dopo AFTER SALES
  rawText: string;
}

/** Node su Vercel non ha DOMMatrix: pdfjs lo usa anche solo per estrarre il testo. */
function installDomMatrix() {
  const g = globalThis as { DOMMatrix?: unknown };
  if (typeof g.DOMMatrix !== "undefined") return;
  class DOMMatrixPolyfill {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    is2D = true;
    constructor(init?: number[] | string) {
      if (Array.isArray(init) && init.length >= 6) {
        this.a = init[0];
        this.b = init[1];
        this.c = init[2];
        this.d = init[3];
        this.e = init[4];
        this.f = init[5];
      }
    }
    scaleSelf() {
      return this;
    }
    translateSelf() {
      return this;
    }
    multiplySelf() {
      return this;
    }
    preMultiplySelf() {
      return this;
    }
    invertSelf() {
      return this;
    }
    inverse() {
      return new DOMMatrixPolyfill();
    }
    translate() {
      return new DOMMatrixPolyfill();
    }
    scale() {
      return new DOMMatrixPolyfill();
    }
  }
  g.DOMMatrix = DOMMatrixPolyfill;
}

export interface PdfTextCell {
  x: number;
  y: number;
  text: string;
}

/** Testo con la posizione in pagina. Serve per le liste motori/sensori in PDF. */
export async function extractPdfCells(filePath: string): Promise<PdfTextCell[]> {
  installDomMatrix();
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs" as string);
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs" as string)) as {
    getDocument: (src: { data: Uint8Array; useSystemFonts?: boolean }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
        destroy?: () => Promise<void>;
      }>;
    };
  };
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const cells: PdfTextCell[] = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      for (const raw of content.items) {
        if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
        const item = raw as { str?: string; transform?: number[] };
        const text = String(item.str ?? "").trim();
        const transform = item.transform;
        if (!text || !transform) continue;
        cells.push({
          x: transform[4] ?? 0,
          y: (transform[5] ?? 0) + (pageNo - 1) * 100000,
          text,
        });
      }
    }
  } finally {
    await doc.destroy?.();
  }
  return cells;
}

/** Estrae il testo dal PDF usando pdf-parse (v2). */
export async function extractPdfText(filePath: string): Promise<string> {
  installDomMatrix();
  const buf = fs.readFileSync(filePath);
  // Carica il worker nello stesso processo. Su Vercel il fake worker di pdfjs
  // cerca pdf.worker.mjs accanto a pdf.mjs e quel file non c'è nel bundle.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs" as string);
  const mod = await import("pdf-parse");
  const PDFParse = mod.PDFParse;
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    return res.text ?? "";
  } finally {
    try {
      await parser.destroy?.();
    } catch {
      /* ignore */
    }
  }
}

/** Riga che chiude un item d'ordine: "1 NR 28/10/2025 BE0801" oppure "1,000 NR 53.260,00 POS. … BF0509". */
const ITEM_LINE = /^\d[\d.,]*\s+NR\b.*?\b(B[A-Z]\d{4})\s*$/i;
const PAGE_FOOTER = /^--\s*\d+\s+of\s+\d+\s*--$/i;

/** Estrae header + descrizione item dal testo dell'ordine. */
export function parseOrderText(text: string): Omit<ParsedOrder, "rawText"> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Header
  const firstLine = lines.find((l) => l.length > 0) ?? "";
  const projectLine = lines.find((l) => /REF\.\s*PROJECT/i.test(l)) ?? firstLine;
  const projectName = projectLine.split(/\t|REF\. PROJECT/i)[0].trim();

  let orderNumber: string | undefined;
  let orderDate: string | undefined;
  const docMatch = text.match(/NR\.\s*DOCUMENTO\s+(\S+)\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (docMatch) {
    orderNumber = docMatch[1];
    orderDate = docMatch[2];
  } else {
    orderNumber = text.match(/DOCUMENT\s+NO\.\s*\n\s*(\S+)/i)?.[1];
    orderDate = text.match(/\bDATE\s*\n\s*(\d{2}\/\d{2}\/\d{4})/)?.[1];
  }

  let customer: string | undefined;
  const docLineIdx = lines.findIndex((l) => /NR\.\s*DOCUMENTO/i.test(l));
  if (docLineIdx >= 0) {
    for (let i = docLineIdx + 1; i < lines.length; i++) {
      if (lines[i]) {
        customer = lines[i];
        break;
      }
    }
  } else {
    customer = text.match(/Invoiced customer:\s*\S+\s*-\s*([^\[\n]+)/i)?.[1]?.trim();
  }

  const location =
    /SINGAPORE/i.test(projectName) ? "SINGAPORE" : undefined;

  const itemLines: { code: string; line: number; position?: string }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(ITEM_LINE);
    if (!m) return;
    const position = l.match(/POS\.\s*(\d+(?:\.\d+)*)/i)?.[1];
    itemLines.push({ code: m[1].toUpperCase(), line: i, position });
  });

  // Tutti i codici in ordine (unici): prima le righe item, altrimenti ogni codice nel testo
  const allItems: string[] = [];
  const source = itemLines.length ? itemLines.map((r) => r.code) : jobCodes(text);
  for (const code of source) {
    if (!allItems.includes(code)) allItems.push(code);
  }

  // Item "AFTER SALES": la prima riga item da quella dicitura in poi
  const asLine = lines.findIndex((l) => /AFTER\s*SALES/i.test(l));
  let afterSalesCode: string | undefined;
  if (asLine >= 0 && itemLines.length) {
    afterSalesCode = itemLines.find((r) => r.line >= asLine)?.code;
  } else if (asLine >= 0) {
    const asPos = text.search(/AFTER\s*SALES/i);
    for (const m of text.matchAll(jobCodeRegex())) {
      if ((m.index ?? 0) < asPos) afterSalesCode = m[0].toUpperCase();
      else break;
    }
  }

  // Descrizioni per blocco (marker compatto *BE####*)
  const descByCode = new Map<string, string>();
  const blockRe = /\*(B[A-Z]\d{4})\*/g;
  const anchors: { code: string; idx: number }[] = [];
  for (const m of text.matchAll(blockRe)) {
    anchors.push({ code: m[1], idx: m.index ?? 0 });
  }
  // Senza marker la descrizione segue la riga item, fino alla successiva
  if (!anchors.length) {
    itemLines.forEach((row, i) => {
      const end = i + 1 < itemLines.length ? itemLines[i + 1].line : lines.length;
      const desc: string[] = [];
      for (let j = row.line + 1; j < end; j++) {
        if (PAGE_FOOTER.test(lines[j])) break;
        if (lines[j]) desc.push(lines[j]);
      }
      if (desc.length && !descByCode.has(row.code)) descByCode.set(row.code, desc.join(" "));
    });
  }
  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i].idx;
    const end = i + 1 < anchors.length ? anchors[i + 1].idx : text.length;
    const block = text.slice(start, end);
    const blockLines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      // rimuove i marker e la riga finale "qty NR data commessa"
      .filter((l) => !/^\*.*\*$/.test(l))
      .filter((l) => !/^\d+\s+NR\b/i.test(l))
      .filter((l) => !new RegExp(`^${anchors[i].code}$`).test(l));
    if (blockLines.length) descByCode.set(anchors[i].code, blockLines.join(" "));
  }

  // Item inclusi = dopo AFTER SALES
  let includedCodes = allItems;
  if (afterSalesCode) {
    const idx = allItems.indexOf(afterSalesCode);
    if (idx >= 0) includedCodes = allItems.slice(idx + 1);
  }
  const positionByCode = new Map<string, string>();
  for (const row of itemLines) {
    if (row.position && !positionByCode.has(row.code)) positionByCode.set(row.code, row.position);
  }
  const includedItems: OrderItem[] = includedCodes.map((code) => ({
    code,
    description: descByCode.get(code),
    position: positionByCode.get(code),
  }));

  return {
    header: {
      projectName: projectName || undefined,
      customer,
      orderNumber,
      orderDate,
      location,
      currency: "EUR",
    },
    allItems,
    afterSalesCode,
    includedItems,
  };
}

/** Parsa il documento d'ordine PDF. */
export async function parseOrderPdf(filePath: string): Promise<ParsedOrder> {
  const text = await extractPdfText(filePath);
  const parsed = parseOrderText(text);
  return { ...parsed, rawText: text };
}
