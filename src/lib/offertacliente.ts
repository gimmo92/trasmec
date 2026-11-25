import path from "node:path";
import { leggiMsg, MAX_MAIL_BODY } from "./msgmail";
import { askClaude, isApiKeyConfigured } from "./anthropic";
import { assiemeDaListino, kitPerRuota, passiKit, passoDaModello, type KitComponente } from "./kitsettori";
import { getIstruzioni } from "./istruzioni";
import { extractPdfTextFromBuffer } from "./orderpdf";
import type { DistintaComponent, DistintaFile, DistintaSection, RuotaSettori, SourceHit } from "./sorgente";
import { findSource, sourceFromUpload, type SorgenteCaricato } from "./sorgente";
import { priceArticle } from "./ypri";

/** Condizioni standard dell'offerta ricambi (lo sconto viene dal cliente nel listino YPRI). */
const GIORNI = 20;

/** Voci "virtuali" della distinta per le ruote portasettori: Claude le sceglie come le altre. */
const VOCE_SETTORI: Record<RuotaSettori["lato"], string> = {
  comando: "Settori lato comando",
  rinvio: "Settori lato rinvio",
};
const INCITERM = "Free carrier (CASALBUTTANO)";
const PAGAMENTO = "Bank transfer 90 days end of month";
const IMBALLO = "PALLET WITH PLASTIC";

export interface RichiestaRiga {
  componente: string;
  quantita: number | null;
  /** Titoli di voce distinta indicati da Claude. */
  voci?: string[];
  /** Ruota dentata letta dai documenti (lato, denti, passo e disegno specifico della macchina). */
  ruota?: { lato: RuotaSettori["lato"]; z: number; passo: string; disegno: string };
  /** Catena di trasporto letta dai documenti (metri chiesti in quantita). */
  catena?: CatenaLetta;
}

/** Dati della catena di trasporto: dal manuale/distinta della macchina. */
interface CatenaLetta {
  maglia: string;
  materiale: string;
  /** Passo dell'attrezzatura (raschianti), in mm: es. P=426 = un raschiante ogni 3 maglie da 142. */
  passoAttrezzatura: number | null;
  raschiante: string;
  disegno: string;
}

interface PezzoLetto {
  descrizione?: string;
  quantita?: number;
  voci?: string[];
  tipo?: string;
  lato?: string;
  z?: number | string;
  passo?: number | string;
  disegno?: string;
  maglia?: string;
  materiale?: string;
  passoAttrezzatura?: number | string;
  raschiante?: string;
}

interface LetturaMail {
  cliente?: string;
  indirizzo?: string[];
  attenzione?: string;
  commessa?: string;
  matricola?: string;
  /** Macchine vecchie: numero di matricola progressivo con l'anno (es. 2299/2000). */
  sn?: string;
  rdo?: string;
  /** Modello della macchina Trasmec (dalla targhetta in foto o dal testo), es. TK40PNZV. */
  macchina?: string;
  pezzi?: PezzoLetto[];
}

/** Foto allegata alla mail (es. targhetta della macchina). */
export interface ImmagineMail {
  name: string;
  type: string;
  data: Uint8Array;
}

export interface OffertaRiga {
  pos: string;
  articolo: string;
  descrizione: string;
  disegno: string;
  um: string;
  qty: number | null;
  prezzo: number | null;
  sconto: number | null;
  giorni: number | null;
}

export interface OffertaCliente {
  numero: string;
  data: string;
  validita: string;
  clienteNome: string;
  clienteIndirizzo: string[];
  destinazione: string;
  incoterm: string;
  redattore: string;
  rifInterno: string;
  rdo: string;
  attenzione: string;
  pagamento: string;
  imballo: string;
  intro: string;
  righe: OffertaRiga[];
  consegna: string;
  avvisi: string[];
  fonti: string[];
}

const STOP = new Set([
  "completo",
  "completa",
  "denti",
  "temprati",
  "delle",
  "della",
  "degli",
  "dello",
  "per",
  "con",
  "una",
  "uno",
  "matricola",
  "coclee",
  "coclea",
]);

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function decodeQuotedPrintable(input: string): string {
  const soft = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(soft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBody(body: string, encoding: string): string {
  if (/base64/i.test(encoding)) {
    return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  }
  if (/quoted-printable/i.test(encoding)) return decodeQuotedPrintable(body);
  return body;
}

export function textFromEml(raw: string): { subject: string; text: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const headerEnd = normalized.search(/\r?\n\r?\n/);
  const top = headerEnd >= 0 ? normalized.slice(0, headerEnd) : normalized;
  const unfolded = top.replace(/\r?\n[ \t]+/g, " ");
  const subject = unfolded.match(/^Subject:\s*(.*)$/im)?.[1]?.trim() ?? "";
  const boundary = top.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  if (!boundary) {
    return { subject, text: headerEnd >= 0 ? normalized.slice(headerEnd) : "" };
  }
  const chunks: string[] = [];
  for (const part of normalized.split(`--${boundary}`)) {
    if (!/content-type:\s*text\/plain/i.test(part)) continue;
    if (/content-disposition:\s*attachment/i.test(part)) continue;
    const splitAt = part.search(/\r?\n\r?\n/);
    if (splitAt < 0) continue;
    const headers = part.slice(0, splitAt);
    const encoding = headers.match(/content-transfer-encoding:\s*(\S+)/i)?.[1] ?? "";
    chunks.push(decodeBody(part.slice(splitAt).replace(/^\r?\n/, ""), encoding));
  }
  const text = chunks.join("\n");
  const decoded = /=[0-9A-Fa-f]{2}/.test(text) ? decodeQuotedPrintable(text) : text;
  return { subject, text: mailProse(decoded) };
}

/** Mail già letta (es. .msg di Outlook letto nel browser): pulisce il corpo come per le .eml. */
export function textFromMailParts(subject: string, body: string): { subject: string; text: string } {
  return { subject: subject.trim(), text: mailProse(body.slice(0, MAX_MAIL_BODY)) };
}

/** Mail salvata da Outlook (.msg): oggetto e testo, come per le .eml. */
export function textFromMsg(data: ArrayBuffer): { subject: string; text: string } {
  const { subject, body } = leggiMsg(data);
  return textFromMailParts(subject, body);
}

/** Allegato di una mail (PDF del cliente: richiesta d'offerta, ordine, elenco pezzi). */
export interface AllegatoMail {
  name: string;
  data: Uint8Array;
}

/** PDF allegati di una .eml (parti application/pdf o con filename .pdf, in base64). */
export function pdfDaEml(raw: string): AllegatoMail[] {
  const out: AllegatoMail[] = [];
  const headerRe = /(?:^|\r?\n)((?:Content-[A-Za-z-]+:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n)+)\r?\n/g;
  for (const match of raw.matchAll(headerRe)) {
    const headers = match[1].replace(/\r?\n[ \t]+/g, " ");
    const name =
      headers.match(/filename\*?="?([^";\r\n]+)"?/i)?.[1] ?? headers.match(/name="?([^";\r\n]+)"?/i)?.[1] ?? "";
    const isPdf = /content-type:\s*application\/pdf/i.test(headers) || /\.pdf$/i.test(name);
    if (!isPdf || !/content-transfer-encoding:\s*base64/i.test(headers)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = raw.indexOf("\n--", start);
    const body = raw.slice(start, end < 0 ? raw.length : end).replace(/\s/g, "");
    if (body.length < 100) continue;
    out.push({ name: name || "allegato.pdf", data: Buffer.from(body, "base64") });
  }
  return out;
}

/** Foto delle .eml (JPEG/PNG in base64): solo quelle abbastanza grandi da non essere loghi. */
export function immaginiDaEml(raw: string): ImmagineMail[] {
  const out: ImmagineMail[] = [];
  const headerRe = /(?:^|\r?\n)((?:Content-[A-Za-z-]+:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n)+)\r?\n/g;
  for (const match of raw.matchAll(headerRe)) {
    const headers = match[1].replace(/\r?\n[ \t]+/g, " ");
    const type = headers.match(/content-type:\s*(image\/(?:jpeg|jpg|png))/i)?.[1]?.toLowerCase();
    if (!type || !/content-transfer-encoding:\s*base64/i.test(headers)) continue;
    const name = headers.match(/filename\*?="?([^";\r\n]+)"?/i)?.[1] ?? headers.match(/name="?([^";\r\n]+)"?/i)?.[1] ?? "foto";
    const start = (match.index ?? 0) + match[0].length;
    const end = raw.indexOf("\n--", start);
    const data = Buffer.from(raw.slice(start, end < 0 ? raw.length : end).replace(/\s/g, ""), "base64");
    // Sotto 60 KB sono loghi della firma; sopra 3,5 MB Claude non le accetta.
    if (data.length < 60 * 1024 || data.length > 3.5 * 1024 * 1024) continue;
    out.push({ name, type: type === "image/png" ? "image/png" : "image/jpeg", data });
  }
  return out.sort((a, b) => b.data.length - a.data.length).slice(0, 3);
}

/** Limite per allegato: i manuali da diversi MB non sono richieste d'offerta. */
const MAX_ALLEGATO = 2 * 1024 * 1024;
/** PDF scansionati (senza testo) che Claude legge come documenti: in tutto al massimo questi byte. */
const MAX_SCANSIONI = 4 * 1024 * 1024;

/**
 * Testo dei PDF allegati dal cliente. I PDF che sono offerte Trasmec (risposte già inviate)
 * non entrano mai nella generazione. I PDF senza testo (scansioni, es. la pagina del manuale
 * con le correzioni a penna del cliente) passano a Claude come documenti da leggere.
 */
async function testoAllegati(
  allegati: AllegatoMail[]
): Promise<{ testo: string; usati: string[]; scartati: string[]; scansioni: AllegatoMail[] }> {
  const parts: string[] = [];
  const usati: string[] = [];
  const scartati: string[] = [];
  const scansioni: AllegatoMail[] = [];
  let pesoScansioni = 0;
  for (const allegato of allegati.slice(0, 6)) {
    if (allegato.data.length > MAX_ALLEGATO) {
      scartati.push(`${allegato.name} (troppo grande)`);
      continue;
    }
    let text = "";
    try {
      text = (await extractPdfTextFromBuffer(allegato.data)).trim();
    } catch {
      scartati.push(`${allegato.name} (non leggibile)`);
      continue;
    }
    if (/spare parts offer|offer number|\bIT\d{5}SPO\d+/i.test(text)) {
      scartati.push(`${allegato.name} (offerta Trasmec)`);
      continue;
    }
    // Moduli anagrafica fornitore (dati bancari di Trasmec): non dicono niente su cliente e pezzi.
    if (/new supplier|supplier name|vendor (?:registration|form)|anagrafica fornitor/i.test(`${allegato.name}\n${text.slice(0, 3000)}`)) {
      scartati.push(`${allegato.name} (modulo fornitore)`);
      continue;
    }
    if (text.length < 20) {
      if (pesoScansioni + allegato.data.length <= MAX_SCANSIONI) {
        pesoScansioni += allegato.data.length;
        scansioni.push(allegato);
        usati.push(`${allegato.name} (scansione)`);
      } else {
        scartati.push(`${allegato.name} (senza testo)`);
      }
      continue;
    }
    usati.push(allegato.name);
    parts.push(`ALLEGATO ${allegato.name}\n${text.slice(0, 8000)}`);
  }
  return { testo: parts.join("\n\n"), usati, scartati, scansioni };
}

function isBase64Line(line: string): boolean {
  return line.length >= 8 && /^[A-Za-z0-9+/=]+$/.test(line);
}

/** Il filo della mail è spesso un altro MIME in base64: tiene solo il testo leggibile. */
function mailProse(text: string): string {
  const pieces: string[] = [];
  const lower = text.toLowerCase();
  let cursor = 0;
  while (cursor < text.length) {
    const at = lower.indexOf("content-transfer-encoding:", cursor);
    if (at < 0) break;
    const lineEnd = text.indexOf("\n", at);
    if (lineEnd < 0) break;
    const header = text.slice(at, lineEnd);
    cursor = lineEnd + 1;
    if (!/base64/i.test(header)) continue;
    while (cursor < text.length) {
      const next = text.indexOf("\n", cursor);
      const line = text.slice(cursor, next < 0 ? text.length : next).trim();
      if (!line) {
        cursor = next < 0 ? text.length : next + 1;
        break;
      }
      if (!/^[A-Za-z-]+:/.test(line)) break;
      cursor = next < 0 ? text.length : next + 1;
    }
    const b64: string[] = [];
    while (cursor < text.length) {
      const next = text.indexOf("\n", cursor);
      const line = text.slice(cursor, next < 0 ? text.length : next).trim();
      if (!isBase64Line(line)) break;
      b64.push(line);
      cursor = next < 0 ? text.length : next + 1;
    }
    if (b64.length < 4) continue;
    const decoded = Buffer.from(b64.join(""), "base64").toString("utf8");
    let words = 0;
    for (const match of decoded.matchAll(/[A-Za-z]{4,}/g)) {
      words += 1;
      if (words > 20) break;
    }
    if (words > 20 && !decoded.includes("\u0000")) pieces.push(decoded);
  }
  const prose = pieces.length ? pieces.join("\n") : text;
  return prose
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/** Tiene la richiesta del cliente. Le mail in cui Trasmec invia un'offerta già fatta non sono un input. */
function customerRequest(text: string): string {
  const re = /On\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+wrote:/gi;
  const marks = [...text.matchAll(re)];
  if (!marks.length) return text;
  const chunks = marks.map((mark, index) => ({
    from: mark[1],
    body: text.slice((mark.index ?? 0) + mark[0].length, marks[index + 1]?.index ?? text.length),
  }));
  const fromCustomer = chunks.filter((chunk) => !/@trasmec\.com/i.test(chunk.from));
  const asking = fromCustomer.filter((chunk) =>
    /provide an offer|offer for|quotation|richiesta di offerta|\bn\.\s*\d+/i.test(chunk.body) &&
    !/enclosed our offer|delivery fca\s*:/i.test(chunk.body)
  );
  const chosen = asking.length ? asking : fromCustomer;
  return chosen.map((chunk) => chunk.body).join("\n") || text;
}

/**
 * Ticket clonati: Trasmec apre il ticket nuovo rispondendo "regarding your request here below …:
 * <richiesta del cliente> … we have opened the new dedicated ticket #N". La richiesta di QUESTO
 * ticket è solo la parte citata; il resto della risposta (numero offerta, tempi) non si usa mai.
 */
function ticketRequest(text: string, ticket: string): string {
  if (!ticket) return "";
  const re = /On\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+wrote:/gi;
  const marks = [...text.matchAll(re)];
  for (let index = 0; index < marks.length; index++) {
    if (!/@trasmec\.com/i.test(marks[index][1])) continue;
    const start = (marks[index].index ?? 0) + marks[index][0].length;
    const body = text.slice(start, marks[index + 1]?.index ?? text.length);
    if (!new RegExp(`ticket\\s*#?\\s*${ticket}\\b`, "i").test(body)) continue;
    const intro = body.search(/regarding your request|in merito alla (?:vostra|sua) richiesta|riguardo alla (?:vostra|sua) richiesta/i);
    if (intro < 0) continue;
    const afterIntro = body.indexOf(":", intro);
    if (afterIntro < 0) continue;
    const rest = body.slice(afterIntro + 1);
    const end = rest.search(/please be informed|we have opened|abbiamo aperto|vi informiamo/i);
    const quoted = (end >= 0 ? rest.slice(0, end) : rest).trim();
    if (quoted.length > 10) return quoted;
  }
  return "";
}

function deliveryDays(text: string): number {
  const request = text.replace(/delivery\s+fca\s*:\s*\d+\s+working\s+days[^\n]*/gi, "");
  const match =
    request.match(/(\d+)\s+working\s+days/i) ||
    request.match(/(\d+)\s+giorni\s+lavorativ/i);
  const days = match ? Number(match[1]) : GIORNI;
  return days > 0 ? days : GIORNI;
}

function formatDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getFullYear()}`;
}

function parseQty(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function codesIn(text: string): string[] {
  const found = text.toUpperCase().match(/\b[A-Z]{1,6}\d{3,}[A-Z0-9-]*\b/g) ?? [];
  return [...new Set(found)];
}

function emailLines(text: string): RichiestaRiga[] {
  const lines: RichiestaRiga[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\n)\s*(?:\*\s*)?n\.\s*(\d+)\s+([^\n]+)/gi;
  for (const match of text.matchAll(re)) {
    const componente = match[2]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const key = norm(componente);
    if (!componente || seen.has(key)) continue;
    seen.add(key);
    lines.push({ componente, quantita: Number(match[1]) });
  }
  return lines;
}

function companyOf(text: string): { nome: string; indirizzo: string[]; attenzione: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const companyRe = /\bS\.?\s*P\.?\s*A\.?\b|\bS\.?\s*R\.?\s*L\.?\b/i;
  const idx = lines.findIndex(
    (line) => companyRe.test(line) && !/trasmec/i.test(line) && line.length < 90
  );
  const nome = idx >= 0 ? lines[idx].replace(/\s+-\s+.*$/, "").trim() : "";
  const around = idx >= 0 ? lines.slice(Math.max(0, idx - 6), idx + 5) : [];
  const via =
    around.find((line) => /^via\s+/i.test(line) && !/bergamo/i.test(line) && line.length < 140) ??
    "";
  const cap =
    around.find((line) => line !== via && /\b\d{5}\b/.test(line) && line.length < 80) ?? "";
  const attenzione =
    [...around]
      .reverse()
      .find(
        (line) =>
          /^[A-ZÀ-Ý][a-zà-ÿ'’]+\s+[A-ZÀ-Ý][a-zà-ÿ'’]+$/.test(line) &&
          !/officer|manager|buyer|department|purchasing|phone/i.test(line)
      ) ?? "";
  return { nome, indirizzo: [via, cap].filter(Boolean), attenzione };
}

function attentionOf(text: string, fallback: string): string {
  const sig = text.match(/buongiorno\s+sig\.?\s+([A-Za-zÀ-ÿ']{2,40})/i);
  if (sig) {
    const surname = sig[1].replace(/[,.].*$/, "").trim();
    const full = text.match(new RegExp(`([A-ZÀ-Ý][a-zà-ÿ']+\\s+${surname})`));
    return full?.[1] ?? surname;
  }
  return fallback;
}

function scoreSection(section: DistintaSection, query: string): number {
  const hay = norm(
    [
      section.title,
      section.code,
      ...Object.values(section.fields),
      ...section.components.flatMap((item) => [item.role, item.tipo]),
    ].join(" ")
  );
  const q = norm(query);
  if (!q) return 0;
  if (hay.includes(q)) return 120;
  const tokens = q
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOP.has(token));
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += token.length >= 6 ? 20 : 10;
  }
  for (const code of codesIn(query)) {
    if (hay.toUpperCase().includes(code)) score += 30;
  }
  return score;
}

/** Codice da una colonna "… codice" (es. "allestimento codice" della catena). */
function fieldCodice(section: DistintaSection): string {
  const key = Object.keys(section.fields).find((name) => /\bcodice$/.test(name));
  return key ? section.fields[key].split(/\s*\/\s*/)[0].trim() : "";
}

/** Catena di trasporto: tipo maglia, materiale perno, numero maglie e lunghezza. */
function chainSpec(section: DistintaSection): string {
  const field = (pattern: RegExp) =>
    Object.entries(section.fields).find(([name]) => pattern.test(name))?.[1]?.split(/\s*\/\s*/)[0] ?? "";
  const bits = ["CONVEYOR CHAIN"];
  const maglia = field(/^maglia/);
  const perno = field(/^perno/);
  const maglie = field(/^maglie/);
  const metri = section.fields.quant;
  if (maglia) bits.push(maglia);
  if (perno) bits.push(`PIN ${perno}`);
  if (maglie) bits.push(`${maglie} LINKS`);
  if (metri) bits.push(`L = ${metri} M`);
  return bits.join(" ").toUpperCase();
}

function englishSpec(section: DistintaSection): string {
  if (/^catena di trasporto/i.test(section.title.trim())) return chainSpec(section);
  const diam = section.fields["d(est) / d(int)"];
  const passi = (section.fields.passo || "")
    .split(/\s*\/\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const versoRaw = (section.fields.verso || "").trim();
  const verso = /^sx$/i.test(versoRaw) ? "LEFT" : /^dx$/i.test(versoRaw) ? "RIGHT" : versoRaw.toUpperCase();
  const spiral = /spir|elica|flight|vite/.test(norm(section.title));
  const bits = [spiral ? "SCREW FLIGHT" : section.title.toUpperCase()];
  if (diam) bits.push(`Ø${diam.replace(/\s/g, "")}`);
  if (verso) bits.push(verso);
  if (section.fields.spessore) bits.push(`THICKNESS ${section.fields.spessore} MM`);
  if (passi.length) bits.push(`PITCH ${passi.join(" / ")}`);
  if (section.fields.z) bits.push(`Z ${section.fields.z}`);
  if (section.fields.materiale) bits.push(section.fields.materiale.toUpperCase());
  if (section.fields.tipo && !section.components.length && !spiral) {
    bits.push(section.fields.tipo.toUpperCase());
  }
  return bits.join(" ").replace(/\s+/g, " ").toUpperCase();
}

function extractJson(text: string): LetturaMail {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Risposta Claude senza JSON");
  return JSON.parse(raw.slice(start, end + 1)) as LetturaMail;
}

function sectionBrief(section: DistintaSection): string {
  const extra = Object.entries(section.fields)
    .filter(([key]) => key !== "quant")
    .slice(0, 6)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return `- ${section.title}${extra ? ` (${extra})` : ""}`;
}

function sectionsFromVoci(sections: DistintaSection[], voci: string[]): DistintaSection[] {
  const found: DistintaSection[] = [];
  for (const voce of voci) {
    const wanted = norm(voce);
    if (!wanted) continue;
    const hit =
      sections.find((section) => norm(section.title) === wanted) ??
      sections.find((section) => {
        const title = norm(section.title);
        return title.includes(wanted) || wanted.includes(title);
      });
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

/** Claude legge la mail e indica pezzi, quantità e la voce di distinta corrispondente. */
async function interpretMail(
  corpus: string,
  sections: DistintaSection[],
  distinta?: DistintaFile,
  immagini: ImmagineMail[] = [],
  documenti: { name: string; data: Uint8Array; trasmec: boolean }[] = []
): Promise<LetturaMail> {
  const enabled = sections.filter((section) => section.enabled).slice(0, 40);
  const ruote = (distinta?.ruoteSettori ?? []).map(
    (ruota) =>
      `- ${VOCE_SETTORI[ruota.lato]} (ruota portasettori z=${ruota.z}, ${ruota.settori} settori${distinta?.passoCatena ? `, passo catena ${distinta.passoCatena}` : ""})`
  );
  const lines = [...enabled.map(sectionBrief), ...ruote];
  const catalog = lines.length ? lines.join("\n") : "(nessuna distinta ancora trovata)";
  const text = await askClaude({
    system: `Sei l'ufficio ricambi Trasmec. Leggi la mail del cliente e capisci per quali pezzi va fatta l'offerta.
Rispondi solo con JSON:
{"cliente":"","indirizzo":[],"attenzione":"","commessa":"","matricola":"","sn":"","macchina":"","rdo":"","pezzi":[{"descrizione":"","quantita":1,"voci":["titolo distinta"],"tipo":"settori|catena|altro","lato":"comando|rinvio","z":0,"passo":"","disegno":"","maglia":"","materiale":"","passoAttrezzatura":"","raschiante":""}]}
Regole:
- Un pezzo per ogni componente chiesto, con la quantità scritta dal cliente (es. "1 pc" = 1).
- "voci" sono titoli ESATTI dell'elenco distinta, se presente. Esempio: screw flight / spira / elica = Spire. Se l'elenco manca, "voci" è [].
- Non inventare prezzi né pezzi non richiesti.
- Il testo è solo la richiesta del cliente: non ricavare codici disegno, prezzi o giorni di consegna da un'offerta già inviata.
- Se c'è la sezione "RICHIESTA DI QUESTO TICKET", i pezzi vengono SOLO da lì. Il CONTESTO serve a capire macchina, matricola e cliente, non aggiunge pezzi.
- Ruote dentate / sprockets / settori: drive end = "Settori lato comando", return end / tail = "Settori lato rinvio". Se non è indicato il lato, usa entrambe le voci.
- cliente è il nome dell'azienda del cliente (es. dal dominio mail o dalla firma), non un reparto o una casella mail; attenzione è la persona che scrive. Mai Trasmec.
- Se ci sono foto, cerca la targhetta Trasmec: macchina = MACHINE TYPE (es. TK99PNZV), matricola = SERIAL NUMBER (es. AX1234C-R009999). Trascrivi esattamente; se un carattere non si legge, lascia il campo vuoto. Senza targhetta, macchina è il modello Trasmec scritto nella mail (es. TK99, TM 99 CLC), se c'è.
- Per ruote dentate / sprockets / settori scrivi nella descrizione anche i denti come "Z=10" se il cliente li indica.
- rdo è il numero della richiesta d'offerta del cliente, solo se scritto (es. "RdO 4500123"). Mai il numero ticket.
DOCUMENTI PDF (scansioni)
- I documenti del CLIENTE (es. pagina "Identificazione" del manuale Trasmec) dicono cosa vuole: il cliente spesso evidenzia le righe dei pezzi e corregge a penna. Un valore barrato è sostituito da quello scritto a mano (es. quantità catena 80 barrata e "45 m" a mano = 45 metri); "3 X" a mano accanto a una ruota = 3 pezzi.
- I documenti TRASMEC (distinta storica della commessa, disegni) servono solo a completare i dati tecnici dei pezzi chiesti (disegni, maglia, materiale, raschiante, passi): non aggiungono pezzi.
- macchina = codice macchina come scritto (es. TK 99 HPx, TK99"HPx). matricola = commessa-disegno (es. AX1234C-R009999: commessa AX1234C, disegno/layout R009999; sulle targhette nuove è il SERIAL NUMBER). commessa = solo la commessa (AX1234C). sn = numero di matricola progressivo con l'anno delle macchine vecchie (es. "1234/1999"), vuoto se non c'è.
- tipo "settori" per ruote dentate / sprockets / ingranaggi a settori: lato comando (drive, traino, motrice) o rinvio (return, tail), z = denti, passo = passo catena in mm (es. 999), disegno = disegno della ruota (es. R009991). Un pezzo per lato.
- tipo "catena" per la catena di trasporto / raschiante: quantita = metri chiesti, maglia (es. 99999), materiale della maglia (sigla accanto alla maglia, es. XX), passoAttrezzatura = passo dei raschianti in mm (es. P=999 → 999), raschiante = baffo/catenaria (es. 500/80x8 R), disegno = disegno della catena (es. R009990ST).
- Campi tecnici che non trovi: stringa vuota. Non inventarli.`,
    prompt: `MAIL
${corpus.slice(0, 14000)}

VOCI DISTINTA ATTIVE
${catalog}${immagini.length ? `\n\nFOTO ALLEGATE: ${immagini.map((image) => image.name).join(", ")}` : ""}${
      documenti.length
        ? `\n\nDOCUMENTI PDF ALLEGATI (in ordine): ${documenti
            .map((doc) => `${doc.name} (${doc.trasmec ? "documento TRASMEC" : "allegato del CLIENTE"})`)
            .join("; ")}`
        : ""
    }`,
    maxTokens: 2500,
    images: immagini.map((image) => ({
      data: image.data,
      mediaType: image.type === "image/png" ? "image/png" : "image/jpeg",
    })),
    documents: documenti.map((doc) => ({
      data: doc.data,
      title: `${doc.trasmec ? "TRASMEC" : "CLIENTE"} - ${doc.name}`,
    })),
  });
  return extractJson(text);
}

function bomQty(section: DistintaSection): number | null {
  return parseQty(section.fields.quant || section.fields["quant"]);
}

/** Contesto di prezzo dell'offerta: codice cliente YPRI (sconto e coefficienti del cliente). */
interface Prezzi {
  cliente: string;
  /** Articoli senza prezzo a listino, per l'avviso finale. */
  mancanti: Set<string>;
  /** Sconti trovati per il cliente (per avvisare se manca il codice). */
  scontoTrovato: boolean;
  /** Lingua della mail del cliente: le descrizioni dell'offerta la seguono. */
  lingua: Lingua;
}

type Lingua = "en" | "it";

const PAROLE_EN = /\b(the|and|please|offer|quotation|quote|for|of|with|we|you|your|our|need|would|like|kind|regards|dear|spare|parts|send|thank|thanks|price|delivery|following|request)\b/g;
const PAROLE_IT = /\b(il|lo|la|gli|le|di|del|della|per|con|che|non|vorremmo|richiesta|preventivo|offerta|ricambi|cordiali|saluti|buongiorno|grazie|prezzo|consegna|seguenti|inviare|chiediamo|vostra|nostra|sono|alla|delle)\b/g;

/** Lingua della richiesta del cliente: inglese o italiano (a parità di indizi, inglese). */
function linguaDi(text: string): Lingua {
  const t = text.toLowerCase();
  const en = t.match(PAROLE_EN)?.length ?? 0;
  const it = t.match(PAROLE_IT)?.length ?? 0;
  return it > en ? "it" : "en";
}

/** Prezzo unitario (listino × CTM × maggiorazione) e sconto cliente dal listino YPRI. */
function prezzoListino(code: string, prezzi: Prezzi): { prezzo: number | null; sconto: number | null } {
  if (!code) return { prezzo: null, sconto: null };
  const result = priceArticle(code, prezzi.cliente || undefined);
  if (!result.found || result.unitPrice <= 0) {
    prezzi.mancanti.add(code);
    return { prezzo: null, sconto: null };
  }
  if (result.scontoSource) prezzi.scontoTrovato = true;
  return { prezzo: result.unitPrice, sconto: prezzi.cliente ? result.sconto : null };
}

function pushLine(
  righe: OffertaRiga[],
  group: number,
  sub: number | null,
  giorni: number,
  line: Omit<OffertaRiga, "pos" | "um" | "prezzo" | "sconto" | "giorni"> & {
    qty: number | null;
    /** Prezzo già calcolato (kit); se manca si cerca l'articolo a listino. */
    prezzo?: number | null;
    sconto?: number | null;
    /** Unità di misura (default NR; la catena va a metri). */
    um?: string;
  },
  prezzi: Prezzi
) {
  const pos = sub === null
    ? String(group).padStart(2, "0")
    : `${String(group).padStart(2, "0")}.${sub}`;
  // Le sottorighe di un kit descrivono il contenuto: il prezzo sta sulla riga del kit.
  const priced =
    sub !== null
      ? { prezzo: null, sconto: null }
      : line.prezzo !== undefined
        ? { prezzo: line.prezzo, sconto: line.sconto ?? null }
        : prezzoListino(line.articolo, prezzi);
  righe.push({
    pos,
    articolo: line.articolo,
    descrizione: line.descrizione,
    disegno: line.disegno,
    um: line.um ?? "NR",
    qty: line.qty,
    prezzo: priced.prezzo,
    sconto: priced.sconto,
    giorni: sub === null ? giorni : null,
  });
}

/** Descrizioni del listino (in italiano) rese in inglese per l'offerta. */
const GLOSSARIO: [RegExp, string][] = [
  [/\bKIT SETTORI\b/g, "KIT OF SECTORS"],
  [/\bCOMPLETI DI BULLONERIA\b/g, "WITH SCREWS AND NUTS"],
  [/\bKIT BULLONERIA FISSAGGIO SETTORI\b/g, "FIXING KIT FOR SECTORS"],
  [/\bSETTORE\b/g, "SECTOR"],
  [/\bSETTORI\b/g, "SECTORS"],
  [/\bVERNICIAT[OAIE]\b/g, "PAINTED"],
  [/\bCEMENTATO E TEMPRATO\b/g, "CASE HARDENED AND HARDENED"],
  [/\bVITE TE\b/g, "HEX HEAD SCREW"],
  [/\bRONDELLA PIANA\b/g, "FLAT WASHER"],
  [/\bDADO AUTOBLOCCANTE\b/g, "SELF-LOCKING NUT"],
  [/\bZINCAT[OAIE]\b/g, "GALVANIZED"],
  [/\bSP\./g, "TH."],
  [/\bCOMPLETO DI CUSCINETTI E TENUTE\b/g, "COMPLETE WITH BEARINGS AND SEALS"],
  [/\bCOMPLETO DI BULLONERIA\b/g, "COMPLETE WITH BOLTS"],
  [/\bINGRASSATORI\b/g, "GREASE NIPPLES"],
  [/\bCORPO SUPPORTO\b/g, "SUPPORT BODY"],
  [/\bSUPPORTO\b/g, "SUPPORT"],
  [/\bRALLA PER CUSCINETTO ASSIALE\b/g, "WASHER FOR AXIAL BEARING"],
  [/\bCUSCINETTO RADIALE\b/g, "RADIAL BEARING"],
  [/\bCUSCINETTO ASSIALE\b/g, "AXIAL BEARING"],
  [/\bCUSCINETTO\b/g, "BEARING"],
  [/\bGUARNIZIONE FRONTALE\b/g, "FRONT SEAL"],
  [/\bGUARNIZIONE POSTERIORE\b/g, "REAR SEAL"],
  [/\bGUARNIZIONE\b/g, "SEAL"],
];

function inglese(text: string): string {
  let out = text.toUpperCase();
  for (const [re, en] of GLOSSARIO) out = out.replace(re, en);
  return out.replace(/\s+/g, " ").trim();
}

/** Descrizione di listino (italiano) nella lingua dell'offerta. */
function inLingua(text: string, lingua: Lingua): string {
  return lingua === "en" ? inglese(text) : text.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Porta tutte le descrizioni nella lingua della mail: distinte e richieste del cliente
 * possono essere in un'altra lingua. Codici, misure e sigle restano come sono.
 */
async function traduciDescrizioni(righe: OffertaRiga[], lingua: Lingua, avvisi: string[]): Promise<void> {
  if (!righe.length || !isApiKeyConfigured()) return;
  const nome = lingua === "en" ? "inglese" : "italiano";
  let risposta: string;
  try {
    risposta = await askClaude({
      system: `Traduci descrizioni di ricambi industriali (trasportatori, coclee, catene, supporti, cuscinetti) in ${nome} tecnico commerciale.
Rispondi solo con JSON: {"righe":[{"pos":"01","descrizione":"..."}]}
Regole:
- Includi solo le righe la cui descrizione non è già in ${nome}.
- MAIUSCOLO, conciso, terminologia tecnica corretta (es. SPROCKET, BEARING, SUPPORT, SCREW FLIGHT, CHAIN).
- Non cambiare codici, sigle, modelli, misure, numeri e unità (es. TM 99 CLC, UCFL999, Ø999/111, P999).
- Non aggiungere informazioni.`,
      prompt: JSON.stringify(righe.map(({ pos, descrizione }) => ({ pos, descrizione }))),
      maxTokens: 3000,
    });
  } catch (err) {
    avvisi.push(`Descrizioni non tradotte in ${nome}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  try {
    const data = jsonObject(risposta);
    for (const raw of Array.isArray(data.righe) ? data.righe : []) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const riga = righe.find((row) => row.pos === String(item.pos ?? ""));
      const descrizione = typeof item.descrizione === "string" ? item.descrizione.trim() : "";
      if (riga && descrizione) riga.descrizione = descrizione.toUpperCase();
    }
  } catch {
    avvisi.push(`Descrizioni non tradotte in ${nome}: risposta non valida.`);
  }
}

/** Ruote della distinta richieste: dalle voci scelte da Claude o dal testo della riga. */
function ruoteRichieste(richiesta: RichiestaRiga, distinta?: DistintaFile): RuotaSettori[] {
  const ruote = distinta?.ruoteSettori ?? [];
  if (!ruote.length) return [];
  const voci = (richiesta.voci ?? []).map(norm);
  const daVoci = ruote.filter((ruota) => voci.includes(norm(VOCE_SETTORI[ruota.lato])));
  if (daVoci.length) return daVoci;
  const text = norm(richiesta.componente);
  if (!/settor|sector|sprocket|ruot[ae] dentat|ruota portasettori|ingranagg/.test(text)) return [];
  const comando = /drive|comando|motric|head/.test(text);
  const rinvio = /return|rinvio|tail|tension/.test(text);
  if (comando === rinvio) return ruote;
  return ruote.filter((ruota) => (ruota.lato === "comando" ? comando : rinvio));
}

/** Ultima risorsa per il nome cliente: il dominio di chi scrive (kronospan-riga.lv → KRONOSPAN RIGA). */
function aziendaDaDominio(text: string): string {
  const generici = /^(gmail|outlook|hotmail|yahoo|libero|live|icloud|tiscali|virgilio|alice|gmx|mail|aol)$/i;
  for (const match of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) {
    const parti = match[1].toLowerCase().split(".");
    const nome = parti.length > 2 ? parti[parti.length - 2] : parti[0];
    if (/trasmec|jitbit/.test(match[1]) || generici.test(nome)) continue;
    return nome.replace(/[-_]+/g, " ").toUpperCase();
  }
  return "";
}

/**
 * "Offer req.": il numero di RdO del cliente se c'è, altrimenti l'oggetto originale della sua mail
 * (senza Fwd/FW/RE e senza il numero ticket). Il ticket va già in "Internal ref.".
 */
function richiestaOfferta(rdo: string, ticket: string, subject: string): string {
  const numero = rdo.trim();
  if (numero && numero !== ticket) return numero;
  let oggetto = subject;
  let prima = "";
  while (prima !== oggetto) {
    prima = oggetto;
    oggetto = oggetto.replace(/^\s*(?:(?:fwd?|fw|re|r|i|aw|wg|tr|rif)\s*:|\{\d+\}\s*:?|\[[^\]]*\]\s*:?)\s*/i, "");
  }
  // "PRICE OFFER REQUEST-TRASMEC": il nome del fornitore non fa parte della richiesta.
  oggetto = oggetto.replace(/\s*[-–:]?\s*\bTRASMEC\b\s*$/i, "").replace(/^\s*\bTRASMEC\b\s*[-–:]?\s*/i, "");
  return oggetto.trim() || numero;
}

/** Modello di trasportatore Trasmec scritto nella mail (es. "TK40 conveyor", "TK 40 PNZ", 'TK30"HPDo' → TK30HP). */
function modelloNelTesto(text: string): string {
  const match = text.match(/\bT[KC]K?\s*(\d{2})\s*["”]?\s*(PNZ\s*V?|HP|N(?![A-Za-z]))?/i);
  return match ? `TK${match[1]}${(match[2] ?? "").replace(/\s+/g, "")}`.toUpperCase() : "";
}

function testo(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

/** Numero da "426", "P=426", "142 mm". */
function numero(value: unknown): number | null {
  const match = testo(value).match(/\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(",", ".")) : null;
}

/** Pezzo letto da Claude → riga richiesta, con i dati strutturati di ruote e catena. */
function richiestaDaPezzo(pezzo: PezzoLetto): RichiestaRiga {
  const riga: RichiestaRiga = {
    componente: (pezzo.descrizione ?? "").trim(),
    quantita: typeof pezzo.quantita === "number" && pezzo.quantita > 0 ? pezzo.quantita : 1,
    voci: (pezzo.voci ?? []).map((voce) => voce.trim()).filter(Boolean),
  };
  const tipo = testo(pezzo.tipo).toLowerCase();
  const z = numero(pezzo.z);
  const lato = testo(pezzo.lato).toLowerCase();
  if (tipo === "settori" && z && /^(comando|rinvio)$/.test(lato)) {
    riga.ruota = {
      lato: lato as RuotaSettori["lato"],
      z,
      passo: String(numero(pezzo.passo) ?? "").replace(/\.0+$/, ""),
      disegno: testo(pezzo.disegno).toUpperCase(),
    };
  }
  if (tipo === "catena") {
    riga.catena = {
      maglia: testo(pezzo.maglia).replace(/\s+/g, ""),
      materiale: testo(pezzo.materiale).toUpperCase(),
      passoAttrezzatura: numero(pezzo.passoAttrezzatura),
      raschiante: testo(pezzo.raschiante),
      disegno: testo(pezzo.disegno),
    };
  }
  return riga;
}

/**
 * Catena di trasporto a metri: codice = disegno della catena a listino (R001788 → R001788ST, la
 * catena completa), descrizione da modello, maglia, passo raschianti e baffo; i metri chiesti
 * si arrotondano per eccesso a un numero intero di passi dei raschianti (60 m con P=426 → 60,066 m).
 */
function rigaCatena(
  catena: CatenaLetta,
  metri: number | null,
  modello: string,
  lingua: Lingua,
  avvisi: string[]
): { articolo: string; descrizione: string; disegno: string; qty: number | null } {
  const disegno = catena.disegno.trim();
  const base = disegno.toUpperCase().replace(/ST$/, "");
  const articolo =
    [disegno.toUpperCase(), `${base}ST`, base].find((code) => code && priceArticle(code).unitPrice > 0) ??
    disegno.toUpperCase();
  const passoMaglia = Number(catena.maglia.match(/^(\d{3})\d{2}/)?.[1] ?? 0);
  const passo = catena.passoAttrezzatura || passoMaglia;
  let qty = metri;
  if (metri && passo) {
    qty = Math.round(Math.ceil((metri * 1000) / passo - 1e-9) * passo) / 1000;
    if (qty !== metri) {
      avvisi.push(
        `Catena: ${metri} m chiesti → ${qty.toLocaleString("it-IT")} m, multiplo del passo ${catena.passoAttrezzatura ? "dei raschianti" : "maglia"} di ${passo} mm.`
      );
    }
  }
  const raschiante = catena.raschiante.toUpperCase().replace(/\s+/g, " ").replace(/\s+([A-Z])$/, "-$1");
  const maglia = `${catena.maglia}${catena.materiale}`;
  const parti =
    lingua === "en"
      ? ["COMPLETE CHAIN", modello && `FOR ${modello}`, maglia && `LINK ${maglia}`, catena.passoAttrezzatura && `P=${catena.passoAttrezzatura}`, raschiante && `SCRAPER ${raschiante}`]
      : ["CATENA COMPLETA", modello && `PER ${modello}`, maglia && `MAGLIA ${maglia}`, catena.passoAttrezzatura && `P=${catena.passoAttrezzatura}`, raschiante && `RASCHIANTE ${raschiante}`];
  return { articolo, descrizione: parti.filter(Boolean).join(" "), disegno, qty };
}

/**
 * Ruote richieste senza distinta: denti da "z=10" / "Z10" / "10 teeth" e lato da
 * drive/comando o return/rinvio (entrambi i lati se non è detto). Settori sconosciuti (0).
 */
function ruoteDaTesto(richiesta: RichiestaRiga): RuotaSettori[] {
  if (richiesta.ruota) return [{ lato: richiesta.ruota.lato, z: richiesta.ruota.z, settori: 0 }];
  const text = norm(richiesta.componente);
  if (!/settor|sector|sprocket|ruot[ae] dentat|ruota portasettori|ingranagg/.test(text)) return [];
  const z = Number(
    text.match(/\bz\s*=?\s*(\d{1,2})\b/)?.[1] ?? text.match(/\b(\d{1,2})\s*(?:teeth|denti)\b/)?.[1] ?? 0
  );
  if (!z) return [];
  const comando = /drive|comando|motric|head/.test(text);
  const rinvio = /return|rinvio|tail|tension/.test(text);
  const lati: RuotaSettori["lato"][] = comando === rinvio ? ["comando", "rinvio"] : [comando ? "comando" : "rinvio"];
  return lati.map((lato) => ({ lato, z, settori: 0 }));
}

/**
 * Passo catena per il kit: dal modello (Maglie Attrezzate: TK40PNZ → 26040 → 260), da "P260" nella
 * richiesta, oppure l'unico passo a listino per quel lato e quei denti.
 */
function passoPerRuota(ruota: RuotaSettori, modello: string, testo: string): string {
  const daModello = modello ? passoDaModello(modello) : "";
  if (daModello) return daModello;
  const scritto = testo.match(/\bP\s*=?\s*(\d{3})\b/i)?.[1];
  if (scritto) return scritto;
  const passi = passiKit(ruota.lato, ruota.z);
  return passi.length === 1 ? passi[0] : "";
}

/** Riga kit (con prezzo = somma dei componenti a listino) e sottorighe .1, .2 … senza prezzo. */
function pushKit(
  righe: OffertaRiga[],
  group: number,
  giorni: number,
  kit: { code: string; descrizione: string; componenti: KitComponente[] },
  qty: number,
  prezzi: Prezzi
) {
  const proprio = prezzoListino(kit.code, { ...prezzi, mancanti: new Set() });
  let prezzo = proprio.prezzo;
  let sconto = proprio.sconto;
  if (prezzo === null) {
    // Kit a prezzo 0 nel listino: vale la somma dei componenti.
    let somma = 0;
    let completo = true;
    for (const comp of kit.componenti) {
      const p = prezzoListino(comp.code, prezzi);
      if (p.prezzo === null) completo = false;
      else somma += p.prezzo * comp.qty;
      if (sconto === null) sconto = p.sconto;
    }
    prezzo = completo ? Math.round(somma * 100) / 100 : null;
    if (!completo) prezzi.mancanti.add(kit.code);
  }
  pushLine(
    righe,
    group,
    null,
    giorni,
    { articolo: kit.code, descrizione: inLingua(kit.descrizione, prezzi.lingua), disegno: "", qty, prezzo, sconto },
    prezzi
  );
  // Le sottorighe riportano il totale per i kit offerti (2 kit da 4 settori → 8 settori).
  kit.componenti.forEach((comp, index) => {
    pushLine(
      righe,
      group,
      index + 1,
      giorni,
      { articolo: comp.code, descrizione: inLingua(comp.descrizione, prezzi.lingua), disegno: comp.disegno, qty: comp.qty * qty },
      prezzi
    );
  });
}

function linesFromSection(
  section: DistintaSection,
  group: number,
  requested: number | null,
  giorni: number,
  prezzi: Prezzi
): OffertaRiga[] {
  const righe: OffertaRiga[] = [];
  const disegno = section.fields.disegno || "";
  if (section.components.length) {
    pushLine(righe, group, null, giorni, {
      articolo: section.code,
      descrizione: section.title.toUpperCase(),
      disegno,
      qty: requested ?? 1,
    }, prezzi);
    section.components.forEach((item: DistintaComponent, index) => {
      const factor = requested ?? 1;
      pushLine(righe, group, index + 1, giorni, {
        articolo: item.tipo,
        descrizione: `${item.role} ${item.tipo}`.toUpperCase(),
        disegno: "",
        qty: item.qty * factor,
      }, prezzi);
    });
    return righe;
  }

  pushLine(righe, group, null, giorni, {
    articolo: section.fields.disegno || section.code || fieldCodice(section),
    descrizione: englishSpec(section),
    disegno,
    qty: requested ?? bomQty(section),
  }, prezzi);
  return righe;
}

function drawingFor(hit: SourceHit, query: string): string {
  const codes = codesIn(query);
  for (const file of hit.files) {
    const base = path.basename(file, path.extname(file)).toUpperCase();
    if (codes.some((code) => base.includes(code) || code.includes(base))) {
      if (/\.(dwg|pdf|png|jpe?g)$/i.test(file)) return path.basename(file, path.extname(file));
    }
  }
  return "";
}

export async function buildOffertaCliente(input: {
  emailRaw?: string;
  /** Mail già letta (ad esempio da un .msg di Outlook). Ha la precedenza su emailRaw. */
  email?: { subject: string; text: string };
  commessa?: string;
  righe?: { componente?: string; quantita?: string }[];
  /** File sorgente indicati dall'utente: se ci sono, si usano al posto della ricerca in cartella. */
  sorgenti?: SorgenteCaricato[];
  /** PDF allegati alla mail (dal browser, per le .msg). Quelli delle .eml si leggono qui. */
  allegati?: AllegatoMail[];
  /** Foto allegate alla mail (dal browser, per le .msg). Quelle delle .eml si leggono qui. */
  immagini?: ImmagineMail[];
  /** Codice cliente YPRI: coefficienti e sconto del cliente. */
  codiceCliente?: string;
  /** Chi emette l'offerta (operatore Trasmec). */
  redattore?: string;
  now?: Date;
}): Promise<OffertaCliente> {
  const now = input.now ?? new Date();
  const valid = new Date(now);
  valid.setDate(valid.getDate() + 30);

  const email =
    input.email ?? (input.emailRaw ? textFromEml(input.emailRaw) : { subject: "", text: "" });
  const ticket =
    email.subject.match(/\{(\d{6,})\}/)?.[1] ?? email.text.match(/\{(\d{6,})\}/)?.[1] ?? "";
  const richiestaTicket = ticketRequest(email.text, ticket);
  const allegati = await testoAllegati([
    ...(input.allegati ?? []),
    ...(input.emailRaw ? pdfDaEml(input.emailRaw) : []),
  ]);
  const corpoMail = richiestaTicket
    ? `RICHIESTA DI QUESTO TICKET\n${richiestaTicket}\n\nCONTESTO (messaggi precedenti del cliente: servono a identificare la macchina, non sono la richiesta)\n${email.subject}\n${customerRequest(email.text)}`
    : `${email.subject}\n${customerRequest(email.text)}`;
  // Spesso la richiesta vera è nel PDF allegato (es. "Richiesta di offerta" del cliente).
  const corpus = allegati.testo ? `${corpoMail}\n\nALLEGATI DEL CLIENTE\n${allegati.testo}` : corpoMail;
  const rdo =
    corpus.match(/richiesta di offerta\s+n[°ºo.]?\s*(\d+)/i)?.[1] ??
    corpus.match(/\bRdO\s+(\d+)/i)?.[1] ??
    "";
  const matricole = corpus.match(/matricola\s+([A-Z0-9-]+)/gi)?.map((item) => item.split(/\s+/).pop() ?? "") ?? [];
  const party = companyOf(corpus);
  const manual: RichiestaRiga[] = (input.righe ?? [])
    .map((row) => ({
      componente: (row.componente ?? "").trim(),
      quantita: parseQty(row.quantita),
    }))
    .filter((row) => row.componente);

  const baseNeedles = [
    ticket,
    input.commessa ?? "",
    ...matricole,
    ...codesIn(corpus),
  ].filter(Boolean);
  const caricati = sourceFromUpload(input.sorgenti ?? []);
  // PDF tra i file sorgente (es. distinta storica scansionata di una matricola vecchia):
  // Claude li legge per completare i dati tecnici dei pezzi chiesti.
  const documentiTrasmec: { name: string; data: Uint8Array; trasmec: boolean }[] = [];
  let pesoDocumenti = allegati.scansioni.reduce((sum, doc) => sum + doc.data.length, 0);
  for (const file of input.sorgenti ?? []) {
    if (!file.data || !/\.pdf$/i.test(file.name)) continue;
    if (pesoDocumenti + file.data.length > MAX_SCANSIONI) continue;
    pesoDocumenti += file.data.length;
    documentiTrasmec.push({ name: file.name, data: new Uint8Array(file.data), trasmec: true });
  }
  const prelim = caricati ?? findSource(baseNeedles);

  let lettura: LetturaMail | null = null;
  let claudeError = "";
  if (!manual.length && corpus.trim().length > 40) {
    try {
      if (!isApiKeyConfigured()) throw new Error("API key mancante");
      const immagini = [...(input.immagini ?? []), ...(input.emailRaw ? immaginiDaEml(input.emailRaw) : [])].slice(0, 3);
      lettura = await interpretMail(corpus, prelim?.distinte[0]?.sections ?? [], prelim?.distinte[0], immagini, [
        ...allegati.scansioni.map((doc) => ({ ...doc, trasmec: false })),
        ...documentiTrasmec,
      ]);
    } catch (err) {
      claudeError = err instanceof Error ? err.message : String(err);
    }
  }

  const daClaude: RichiestaRiga[] = (lettura?.pezzi ?? [])
    .map(richiestaDaPezzo)
    .filter((row) => row.componente || row.voci?.length || row.ruota || row.catena);
  const richieste = manual.length ? manual : daClaude.length ? daClaude : emailLines(corpus);

  const needles = [
    ...baseNeedles,
    lettura?.commessa ?? "",
    lettura?.matricola ?? "",
    ...richieste.flatMap((row) => [row.componente, ...(row.voci ?? []), ...codesIn(row.componente)]),
  ].filter(Boolean);
  const hit = caricati ?? findSource(needles) ?? prelim;
  const distinta = hit?.distinte[0];
  const avvisi: string[] = [];
  if (lettura) avvisi.push("Pezzi individuati da Claude nella mail.");
  if (allegati.usati.length) avvisi.push(`Letti gli allegati: ${allegati.usati.join(", ")}.`);
  if (allegati.scartati.length) avvisi.push(`Allegati non usati: ${allegati.scartati.join(", ")}.`);
  if (documentiTrasmec.length && lettura) {
    avvisi.push(`Dati tecnici completati dai documenti Trasmec: ${documentiTrasmec.map((doc) => doc.name).join(", ")}.`);
  }
  if (claudeError) avvisi.push(`Claude non ha letto la mail: ${claudeError}`);
  const fonti = hit ? hit.files.map((file) => path.basename(file)) : [];

  // Avviso sui file sorgente solo se qualche pezzo non si compone dalla Spare Parts List.
  let servonoSorgenti = !richieste.length;
  const avvisoSorgenti = () => {
    if (!hit) {
      avvisi.push("Nessun file sorgente corrisponde alla commessa o al ticket: caricali in «File sorgente».");
    } else if (!distinta) {
      avvisi.push("Trovati allegati, ma nessuna distinta Excel da cui leggere i pezzi.");
    }
  };

  const giorni = deliveryDays(corpus);
  const righe: OffertaRiga[] = [];
  // La lingua si decide sulla richiesta del cliente, non sulle risposte Trasmec nel thread.
  const lingua = linguaDi(
    `${email.subject}\n${richiestaTicket || customerRequest(email.text)}\n${manual.map((row) => row.componente).join("\n")}`
  );
  const prezzi: Prezzi = {
    cliente: (input.codiceCliente ?? "").trim(),
    mancanti: new Set(),
    scontoTrovato: false,
    lingua,
  };
  let group = 1;
  // Modello macchina: distinta, targhetta in foto o testo della mail (serve al passo catena).
  const modelloMacchina = distinta?.meta?.macchina || lettura?.macchina?.trim() || modelloNelTesto(corpus);
  for (const richiesta of richieste) {
    // Ruote dentate / settori: kit di listino ricavati da ruota (z, lato) e passo catena.
    // Senza distinta, denti e lato vengono dalla richiesta e il passo dal modello della macchina.
    const ruote = ruoteRichieste(richiesta, distinta);
    const daTesto = !ruote.length && !distinta?.ruoteSettori?.length ? ruoteDaTesto(richiesta) : [];
    if (ruote.length || daTesto.length) {
      for (const ruota of ruote.length ? ruote : daTesto) {
        const passo =
          distinta?.passoCatena || richiesta.ruota?.passo || passoPerRuota(ruota, modelloMacchina, richiesta.componente);
        const kit = kitPerRuota(ruota, passo);
        if (!kit) {
          avvisi.push(
            `Settori lato ${ruota.lato} z=${ruota.z}${passo ? ` P${passo}: nessun kit a listino.` : ": passo catena non trovato (manca il modello della macchina o la distinta)."}`
          );
          continue;
        }
        if (!distinta?.passoCatena && !richiesta.ruota?.passo && modelloMacchina) {
          avvisi.push(`Kit settori lato ${ruota.lato}: passo P${passo} dal modello ${modelloMacchina} (foglio Maglie Attrezzate).`);
        }
        // Settori con la foratura della macchina: il disegno della ruota nei documenti
        // (es. R001324) prevale sul disegno standard del settore.
        const disegnoRuota = richiesta.ruota?.disegno;
        if (disegnoRuota && kit.componenti[0]) {
          kit.componenti[0] = { ...kit.componenti[0], disegno: disegnoRuota };
          avvisi.push(`Settori lato ${ruota.lato}: disegno ${disegnoRuota} della ruota della macchina (foratura specifica).`);
        }
        // Senza distinta non si sa quanti settori ha la ruota: un kit per ruota richiesta.
        const kits = ruota.settori
          ? Math.ceil(ruota.settori / kit.settoriPerKit) * (richiesta.quantita ?? 1)
          : richiesta.quantita ?? 1;
        pushKit(righe, group, giorni, kit, kits, prezzi);
        group += 1;
      }
      continue;
    }

    // Catena di trasporto senza distinta Excel: dai dati letti su manuale e distinta storica.
    if (richiesta.catena && !distinta && (richiesta.catena.disegno || richiesta.catena.maglia)) {
      const riga = rigaCatena(richiesta.catena, richiesta.quantita, modelloNelTesto(modelloMacchina), lingua, avvisi);
      pushLine(righe, group, null, giorni, { ...riga, um: "MT" }, prezzi);
      group += 1;
      continue;
    }

    // Codice o modello Trasmec presente nella Spare Parts List (es. C003369, TM 75 CLC):
    // la riga si compone dal listino, anche senza distinta.
    // Il modello della macchina (targhetta, testo) aiuta a trovare il pezzo nel listino.
    const testoRiga = [richiesta.componente, ...(richiesta.voci ?? []), modelloMacchina].join(" ");
    const daListino = /\b[A-Z]{1,6}\d{3,}|\bTM\s*\d{2,3}\b/i.test(testoRiga)
      ? await assiemeDaListino(testoRiga)
      : null;
    if (daListino) {
      pushKit(righe, group, giorni, daListino, richiesta.quantita ?? 1, prezzi);
      group += 1;
      continue;
    }

    servonoSorgenti = true;
    const enabled = (distinta?.sections ?? []).filter((section) => section.enabled);
    const fromVoci = sectionsFromVoci(enabled, richiesta.voci ?? []);
    const ranked = enabled
      .map((section) => ({ section, score: scoreSection(section, richiesta.componente) }))
      .filter((item) => item.score >= 10)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0]?.score ?? 0;
    const chosen = fromVoci.length
      ? fromVoci.map((section) => ({ section }))
      : ranked.filter((item) => item.score === best).slice(0, 1);

    if (!chosen.length) {
      avvisi.push(`Nessuna voce in distinta per «${richiesta.componente}».`);
      pushLine(righe, group, null, giorni, {
        articolo: codesIn(richiesta.componente)[0] ?? "",
        descrizione: richiesta.componente.toUpperCase(),
        disegno: hit ? drawingFor(hit, richiesta.componente) : "",
        qty: richiesta.quantita,
      }, prezzi);
      group += 1;
      continue;
    }

    righe.push(...linesFromSection(chosen[0].section, group, richiesta.quantita, giorni, prezzi));
    group += 1;
  }

  if (servonoSorgenti) avvisoSorgenti();

  if (!richieste.length && hit && !distinta) {
    const stems = [
      ...new Set(
        hit.files
          .filter((file) => /\.(dwg|pdf|png|jpe?g)$/i.test(file))
          .map((file) => path.basename(file, path.extname(file)))
      ),
    ].filter(
      (stem, _index, all) =>
        !all.some(
          (other) =>
            other !== stem &&
            other.toUpperCase().startsWith(stem.toUpperCase()) &&
            other.length > stem.length
        )
    );
    for (const stem of stems) {
      pushLine(righe, group, null, giorni, {
        articolo: stem,
        descrizione: stem.toUpperCase(),
        disegno: stem,
        qty: 1,
      }, prezzi);
      group += 1;
    }
  }

  if (!richieste.length && !righe.length) {
    avvisi.push("Indica almeno un componente, oppure carica una mail che lo descrive.");
  }
  const senzaPrezzo = righe.filter((row) => !row.pos.includes(".") && row.prezzo === null);
  if (senzaPrezzo.length) {
    avvisi.push(
      `Prezzo non trovato nel listino YPRI per: ${senzaPrezzo.map((row) => row.articolo || row.descrizione.slice(0, 40)).join(", ")}.`
    );
  }
  if (!prezzi.cliente && righe.some((row) => row.prezzo !== null)) {
    avvisi.push("Codice cliente mancante: prezzi con i coefficienti standard e senza sconto cliente.");
  } else if (prezzi.cliente && !prezzi.scontoTrovato && righe.some((row) => row.prezzo !== null)) {
    avvisi.push(`Nessuno sconto nel listino YPRI per il cliente ${prezzi.cliente}.`);
  }

  const meta = distinta?.meta;
  const macchina = meta?.macchina || lettura?.macchina?.trim() || "";
  const matricola =
    meta?.matricola || lettura?.matricola || input.commessa || matricole[0] || "";
  // Macchine vecchie: dopo commessa-disegno il numero di matricola con l'anno (SN. 2299/2000).
  const sn = lettura?.sn?.trim() ?? "";
  const intro = [macchina ? `SPARE PARTS FOR ${macchina}` : "SPARE PARTS", [matricola, sn && `SN. ${sn}`].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join("\n");

  await traduciDescrizioni(righe, lingua, avvisi);
  await applicaIstruzioni(righe, avvisi, prezzi);

  return {
    numero: ticket ? `BOZZA ${ticket}` : "BOZZA",
    data: formatDate(now),
    validita: formatDate(valid),
    clienteNome: (lettura?.cliente || party.nome || meta?.cliente || aziendaDaDominio(email.text)).toUpperCase(),
    clienteIndirizzo: lettura?.indirizzo?.filter(Boolean).length
      ? (lettura.indirizzo ?? []).filter(Boolean)
      : party.indirizzo,
    destinazione: "",
    incoterm: INCITERM,
    redattore: (input.redattore ?? "").trim(),
    rifInterno: ticket,
    rdo: richiestaOfferta(lettura?.rdo || rdo, ticket, email.subject),
    attenzione: lettura?.attenzione || attentionOf(corpus, party.attenzione),
    pagamento: PAGAMENTO,
    imballo: IMBALLO,
    intro,
    righe,
    consegna: `ESTIMATED TIME READY: ${giorni} WORKING DAYS AFTER ORDER RECEIPT`,
    avvisi,
    fonti,
  };
}

/**
 * Istruzioni personalizzate (tab "Personalizza istruzioni"): Claude le applica a codici,
 * descrizioni e disegni delle righe già composte. Quantità e prezzi non li tocca; se un codice
 * cambia, il prezzo si ricalcola dal listino. Ogni modifica finisce negli avvisi.
 */
async function applicaIstruzioni(righe: OffertaRiga[], avvisi: string[], prezzi: Prezzi): Promise<void> {
  const regole = getIstruzioni().trim();
  if (!regole || !righe.length || !isApiKeyConfigured()) return;
  let risposta: string;
  try {
    risposta = await askClaude({
      system: `Sei l'ufficio ricambi Trasmec. Applichi le ISTRUZIONI DELL'OPERATORE alle righe di un'offerta ricambi.
Rispondi solo con JSON: {"righe":[{"pos":"01","articolo":"...","descrizione":"...","disegno":"..."}]}
Regole:
- Includi solo le righe che cambiano; [] se nessuna istruzione riguarda queste righe.
- Cambia articolo, descrizione o disegno solo come dicono le istruzioni. Non inventare codici: se un'istruzione richiede dati che non hai, non cambiare niente.
- Descrizioni in ${prezzi.lingua === "en" ? "inglese" : "italiano"}, maiuscole, come nell'offerta.
- Non aggiungere né togliere righe.`,
      prompt: `ISTRUZIONI DELL'OPERATORE
${regole}

RIGHE
${JSON.stringify(righe.map(({ pos, articolo, descrizione, disegno }) => ({ pos, articolo, descrizione, disegno })))}`,
      maxTokens: 3000,
    });
  } catch (err) {
    avvisi.push(`Istruzioni personalizzate non applicate: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  let cambi: unknown[] = [];
  try {
    const data = jsonObject(risposta);
    cambi = Array.isArray(data.righe) ? data.righe : [];
  } catch {
    avvisi.push("Istruzioni personalizzate non applicate: risposta non valida.");
    return;
  }
  const fatti: string[] = [];
  for (const raw of cambi) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const riga = righe.find((row) => row.pos === String(item.pos ?? ""));
    if (!riga) continue;
    const articolo = typeof item.articolo === "string" ? item.articolo.trim() : riga.articolo;
    const descrizione = typeof item.descrizione === "string" ? item.descrizione.trim() : riga.descrizione;
    const disegno = typeof item.disegno === "string" ? item.disegno.trim() : riga.disegno;
    const parti: string[] = [];
    if (articolo && articolo !== riga.articolo) {
      parti.push(`codice ${riga.articolo || "—"} → ${articolo}`);
      riga.articolo = articolo;
      if (!riga.pos.includes(".")) {
        const nuovo = prezzoListino(articolo, prezzi);
        riga.prezzo = nuovo.prezzo;
        riga.sconto = nuovo.sconto;
      }
    }
    if (descrizione && descrizione !== riga.descrizione) {
      parti.push("descrizione");
      riga.descrizione = descrizione;
    }
    if (disegno !== riga.disegno) {
      parti.push(`disegno → ${disegno || "—"}`);
      riga.disegno = disegno;
    }
    if (parti.length) fatti.push(`${riga.pos}: ${parti.join(", ")}`);
  }
  if (fatti.length) avvisi.push(`Istruzioni personalizzate applicate — ${fatti.join("; ")}.`);
}

function jsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Risposta Claude senza JSON");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Risposta Claude senza offerta");
  }
  return parsed as Record<string, unknown>;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).trim().replace(/\s/g, "");
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function textOf(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Applica un'istruzione dell'operatore all'offerta già generata. */
export async function reviseOffertaCliente(
  offer: OffertaCliente,
  istruzione: string
): Promise<OffertaCliente> {
  const text = await askClaude({
    system: `Sei l'ufficio ricambi Trasmec. Modifichi l'offerta JSON secondo l'istruzione dell'operatore.
Rispondi solo con il JSON completo dell'offerta, stesso schema.
Cambia solo i campi richiesti. Descrizioni, condizioni e nota di consegna restano in inglese se l'offerta è in inglese.
qty, prezzo, sconto e giorni sono numeri; prezzo null se non c'è un prezzo.
Non aggiungere pezzi non richiesti. Non modificare avvisi e fonti.`,
    prompt: `OFFERTA
${JSON.stringify(offer)}

ISTRUZIONE
${istruzione}`,
    maxTokens: 4000,
  });
  const data = jsonObject(text);
  const righeRaw = Array.isArray(data.righe) ? data.righe : offer.righe;
  const righe: OffertaRiga[] = righeRaw.map((row, index) => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    const prev = offer.righe[index];
    return {
      pos: textOf(item.pos, prev?.pos ?? String(index + 1).padStart(2, "0")),
      articolo: textOf(item.articolo, prev?.articolo ?? ""),
      descrizione: textOf(item.descrizione, prev?.descrizione ?? ""),
      disegno: textOf(item.disegno, prev?.disegno ?? ""),
      um: textOf(item.um, prev?.um ?? "NR"),
      qty: item.qty === undefined ? (prev?.qty ?? null) : numOrNull(item.qty),
      prezzo: item.prezzo === undefined ? (prev?.prezzo ?? null) : numOrNull(item.prezzo),
      sconto: item.sconto === undefined ? (prev?.sconto ?? null) : numOrNull(item.sconto),
      giorni: item.giorni === undefined ? (prev?.giorni ?? null) : numOrNull(item.giorni),
    };
  });
  const indirizzo = Array.isArray(data.clienteIndirizzo)
    ? data.clienteIndirizzo.map((line) => String(line))
    : offer.clienteIndirizzo;
  return {
    ...offer,
    numero: textOf(data.numero, offer.numero),
    data: textOf(data.data, offer.data),
    validita: textOf(data.validita, offer.validita),
    clienteNome: textOf(data.clienteNome, offer.clienteNome),
    clienteIndirizzo: indirizzo,
    destinazione: textOf(data.destinazione, offer.destinazione),
    incoterm: textOf(data.incoterm, offer.incoterm),
    redattore: textOf(data.redattore, offer.redattore),
    rifInterno: textOf(data.rifInterno, offer.rifInterno),
    rdo: textOf(data.rdo, offer.rdo),
    attenzione: textOf(data.attenzione, offer.attenzione),
    pagamento: textOf(data.pagamento, offer.pagamento),
    imballo: textOf(data.imballo, offer.imballo),
    intro: textOf(data.intro, offer.intro),
    righe,
    consegna: textOf(data.consegna, offer.consegna),
    avvisi: offer.avvisi,
    fonti: offer.fonti,
  };
}
