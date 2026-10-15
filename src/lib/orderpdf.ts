import fs from "node:fs";
import type { OfferHeader } from "./types";

export interface OrderItem {
  code: string; // es. BE0805
  description?: string;
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
  const g = globalThis as typeof globalThis & { DOMMatrix?: unknown };
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

/** Estrae il testo dal PDF usando pdf-parse (v2). */
async function extractPdfText(filePath: string): Promise<string> {
  installDomMatrix();
  const buf = fs.readFileSync(filePath);
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

/** Estrae header + descrizione item dal testo dell'ordine. */
function parseOrderText(text: string): Omit<ParsedOrder, "rawText"> {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  // Header
  const firstLine = lines.find((l) => l.length > 0) ?? "";
  const projectName = firstLine.split(/\t|REF\. PROJECT/i)[0].trim();

  let orderNumber: string | undefined;
  let orderDate: string | undefined;
  const docMatch = text.match(/NR\.\s*DOCUMENTO\s+(\S+)\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (docMatch) {
    orderNumber = docMatch[1];
    orderDate = docMatch[2];
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
  }

  const location =
    /SINGAPORE/i.test(projectName) ? "SINGAPORE" : undefined;

  // Tutti i codici in ordine (unici)
  const allItems: string[] = [];
  for (const m of text.matchAll(/BE\d{4}/g)) {
    if (!allItems.includes(m[0])) allItems.push(m[0]);
  }

  // Item "AFTER SALES": ultimo codice prima della dicitura
  const asPos = text.search(/AFTER\s*SALES/i);
  let afterSalesCode: string | undefined;
  if (asPos >= 0) {
    for (const m of text.matchAll(/BE\d{4}/g)) {
      if ((m.index ?? 0) < asPos) afterSalesCode = m[0];
      else break;
    }
  }

  // Descrizioni per blocco (marker compatto *BE####*)
  const descByCode = new Map<string, string>();
  const blockRe = /\*(BE\d{4})\*/g;
  const anchors: { code: string; idx: number }[] = [];
  for (const m of text.matchAll(blockRe)) {
    anchors.push({ code: m[1], idx: m.index ?? 0 });
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
  const includedItems: OrderItem[] = includedCodes.map((code) => ({
    code,
    description: descByCode.get(code),
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
