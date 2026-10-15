import path from "node:path";
import { askClaude, isApiKeyConfigured } from "./anthropic";
import type { DistintaComponent, DistintaSection, SourceHit } from "./sorgente";
import { findSource } from "./sorgente";

/** Condizioni riprese dall'offerta ricambi IT00126SPO00842R00. */
const SCONTO = 10;
const GIORNI = 20;
const INCITERM = "Free carrier (CASALBUTTANO)";
const PAGAMENTO = "Bank transfer 90 days end of month";
const IMBALLO = "PALLET WITH PLASTIC";

export interface RichiestaRiga {
  componente: string;
  quantita: number | null;
  /** Titoli di voce distinta indicati da Claude. */
  voci?: string[];
}

interface LetturaMail {
  cliente?: string;
  indirizzo?: string[];
  attenzione?: string;
  commessa?: string;
  matricola?: string;
  rdo?: string;
  pezzi?: { descrizione?: string; quantita?: number; voci?: string[] }[];
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

function redattoreOf(text: string): string {
  const offerAt = text.search(/in allegato nostra offerta|enclosed our offer/i);
  if (offerAt < 0) return "";
  const slice = text.slice(Math.max(0, offerAt - 500), offerAt + 400);
  if (/andrea\s+sperolini/i.test(slice)) return "Andrea Sperolini";
  if (/emanuele\s+managlia/i.test(slice)) return "Emanuele Managlia";
  return "";
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

function englishSpec(section: DistintaSection): string {
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
  sections: DistintaSection[]
): Promise<LetturaMail> {
  const enabled = sections.filter((section) => section.enabled).slice(0, 40);
  const catalog = enabled.length
    ? enabled.map(sectionBrief).join("\n")
    : "(nessuna distinta ancora trovata)";
  const text = await askClaude({
    system: `Sei l'ufficio ricambi Trasmec. Leggi la mail del cliente e capisci per quali pezzi va fatta l'offerta.
Rispondi solo con JSON:
{"cliente":"","indirizzo":[],"attenzione":"","commessa":"","matricola":"","rdo":"","pezzi":[{"descrizione":"","quantita":1,"voci":["titolo distinta"]}]}
Regole:
- Un pezzo per ogni componente chiesto, con la quantità scritta dal cliente (es. "1 pc" = 1).
- "voci" sono titoli ESATTI dell'elenco distinta, se presente. Esempio: screw flight / spira / elica = Spire. Se l'elenco manca, "voci" è [].
- Non inventare prezzi né pezzi non richiesti.
- Il testo è solo la richiesta del cliente: non ricavare codici disegno, prezzi o giorni di consegna da un'offerta già inviata.
- cliente e attenzione sono quelli del cliente, non Trasmec.`,
    prompt: `MAIL
${corpus.slice(0, 14000)}

VOCI DISTINTA ATTIVE
${catalog}`,
    maxTokens: 1500,
  });
  return extractJson(text);
}

function bomQty(section: DistintaSection): number | null {
  return parseQty(section.fields.quant || section.fields["quant"]);
}

function pushLine(
  righe: OffertaRiga[],
  group: number,
  sub: number | null,
  giorni: number,
  line: Omit<OffertaRiga, "pos" | "um" | "prezzo" | "sconto" | "giorni"> & {
    qty: number | null;
  }
) {
  const pos = sub === null
    ? String(group).padStart(2, "0")
    : `${String(group).padStart(2, "0")}.${sub}`;
  righe.push({
    pos,
    articolo: line.articolo,
    descrizione: line.descrizione,
    disegno: line.disegno,
    um: "NR",
    qty: line.qty,
    prezzo: null,
    sconto: SCONTO,
    giorni,
  });
}

function linesFromSection(
  section: DistintaSection,
  group: number,
  requested: number | null,
  giorni: number
): OffertaRiga[] {
  const righe: OffertaRiga[] = [];
  const disegno = section.fields.disegno || "";
  if (section.components.length) {
    pushLine(righe, group, null, giorni, {
      articolo: section.code,
      descrizione: section.title.toUpperCase(),
      disegno,
      qty: requested ?? 1,
    });
    section.components.forEach((item: DistintaComponent, index) => {
      const factor = requested ?? 1;
      pushLine(righe, group, index + 1, giorni, {
        articolo: item.tipo,
        descrizione: `${item.role} ${item.tipo}`.toUpperCase(),
        disegno: "",
        qty: item.qty * factor,
      });
    });
    return righe;
  }

  pushLine(righe, group, null, giorni, {
    articolo: section.fields.disegno || section.code,
    descrizione: englishSpec(section),
    disegno,
    qty: requested ?? bomQty(section),
  });
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
  commessa?: string;
  righe?: { componente?: string; quantita?: string }[];
  now?: Date;
}): Promise<OffertaCliente> {
  const now = input.now ?? new Date();
  const valid = new Date(now);
  valid.setDate(valid.getDate() + 30);

  const email = input.emailRaw ? textFromEml(input.emailRaw) : { subject: "", text: "" };
  const corpus = `${email.subject}\n${customerRequest(email.text)}`;
  const ticket = corpus.match(/\{(\d{6,})\}/)?.[1] ?? "";
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
  const prelim = findSource(baseNeedles);

  let lettura: LetturaMail | null = null;
  let claudeError = "";
  if (!manual.length && corpus.trim().length > 40) {
    try {
      if (!isApiKeyConfigured()) throw new Error("API key mancante");
      lettura = await interpretMail(corpus, prelim?.distinte[0]?.sections ?? []);
    } catch (err) {
      claudeError = err instanceof Error ? err.message : String(err);
    }
  }

  const daClaude: RichiestaRiga[] = (lettura?.pezzi ?? [])
    .map((pezzo) => ({
      componente: (pezzo.descrizione ?? "").trim(),
      quantita: typeof pezzo.quantita === "number" && pezzo.quantita > 0 ? pezzo.quantita : 1,
      voci: (pezzo.voci ?? []).map((voce) => voce.trim()).filter(Boolean),
    }))
    .filter((row) => row.componente || row.voci?.length);
  const richieste = manual.length ? manual : daClaude.length ? daClaude : emailLines(corpus);

  const needles = [
    ...baseNeedles,
    lettura?.commessa ?? "",
    lettura?.matricola ?? "",
    ...richieste.flatMap((row) => [row.componente, ...(row.voci ?? []), ...codesIn(row.componente)]),
  ].filter(Boolean);
  const hit = findSource(needles) ?? prelim;
  const distinta = hit?.distinte[0];
  const avvisi: string[] = [];
  if (lettura) avvisi.push("Pezzi individuati da Claude nella mail.");
  if (claudeError) avvisi.push(`Claude non ha letto la mail: ${claudeError}`);
  const fonti = hit ? hit.files.map((file) => path.basename(file)) : [];

  if (!hit) {
    avvisi.push("Nessun file sorgente corrisponde alla commessa o al ticket.");
  } else if (!distinta) {
    avvisi.push("Trovati allegati, ma nessuna distinta Excel da cui leggere i pezzi.");
  }

  const giorni = deliveryDays(corpus);
  const righe: OffertaRiga[] = [];
  let group = 1;
  for (const richiesta of richieste) {
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
      });
      group += 1;
      continue;
    }

    righe.push(...linesFromSection(chosen[0].section, group, richiesta.quantita, giorni));
    group += 1;
  }

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
      });
      group += 1;
    }
  }

  if (!richieste.length && !righe.length) {
    avvisi.push("Indica almeno un componente, oppure carica una mail che lo descrive.");
  }
  if (righe.some((row) => row.prezzo === null)) {
    avvisi.push("I file sorgente non contengono prezzi: quantità, codice e disegno arrivano dalla distinta.");
  }

  const meta = distinta?.meta;
  const macchina = meta?.macchina || "";
  const matricola =
    meta?.matricola || lettura?.matricola || input.commessa || matricole[0] || "";
  const intro = [macchina ? `SPARE PART FOR ${macchina}` : "SPARE PART", matricola]
    .filter(Boolean)
    .join("\n");

  return {
    numero: ticket ? `BOZZA ${ticket}` : "BOZZA",
    data: formatDate(now),
    validita: formatDate(valid),
    clienteNome: lettura?.cliente || party.nome || meta?.cliente || "",
    clienteIndirizzo: lettura?.indirizzo?.filter(Boolean).length
      ? (lettura.indirizzo ?? []).filter(Boolean)
      : party.indirizzo,
    destinazione: "",
    incoterm: INCITERM,
    redattore: redattoreOf(corpus),
    rifInterno: ticket,
    rdo: lettura?.rdo || rdo,
    attenzione: lettura?.attenzione || attentionOf(corpus, party.attenzione),
    pagamento: PAGAMENTO,
    imballo: IMBALLO,
    intro,
    righe,
    consegna: `DELIVERY FCA: ${giorni} WORKING DAYS AFTER ORDER RECEIPT`,
    avvisi,
    fonti,
  };
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
