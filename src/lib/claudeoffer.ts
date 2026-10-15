import type { Offer, ProposalLine, SpareIndexRow } from "./types";
import { askClaude, DEFAULT_MODEL, isApiKeyConfigured } from "./anthropic";
import { getIstruzioni } from "./istruzioni";

export const OFFER_SYSTEM_PROMPT = `Sei l'editor commerciale delle offerte ricambi Trasmec.

Ricevi una BOZZA OFFERTA già costruita da regole fisse (distinta, tabella indici, Spare Parts List, motori ML, sensori SL). Il tuo compito NON è ricalcolare l'offerta.

COMPITO
- Riscrivi SOLO il campo descriptionEN di ogni riga, in inglese commerciale conciso.
- Applica la colonna "strutturaDescrizione" dell'indice se presente. Segnaposto: {modello}, {resto}, {model} = famiglia/modello ricavato dalla distinta (es. TM100CLC, UCFL208). "X più numero" → X + misura (es. UCFL208). Non aggiungere "Support" se l'indice non è un supporto.
- Per i gruppi "cuscinetti" (highlightGroup=cuscinetti): la prima riga è l'assieme (supporto/kit); le successive sono i componenti gialli della scheda (cuscinetti, ralle, tenute/ANT). Non fondere le righe. Descrizione assieme dal template; sotto = tipo + modello, breve.
- Motori e sensori: tieni modello/funzione, togli rumore di distinta.

VIETATO
- Aggiungere, togliere o riordinare righe.
- Cambiare code, bomCode, quantità, U.M., mapped, highlightGroup, compoundHue.
- Inventare codici o pezzi non presenti nella bozza.
- Restituire markdown o testo fuori dal JSON.

OUTPUT
JSON stretto:
{"lines":[{"id":"string","descriptionEN":"string"}]}
Una voce per ogni id ricevuto.`;

function systemPrompt(): string {
  const extra = getIstruzioni().trim();
  if (!extra) return OFFER_SYSTEM_PROMPT;
  return `${OFFER_SYSTEM_PROMPT}

ISTRUZIONI AGGIUNTIVE DELL'OPERATORE
Segui anche queste indicazioni. Restano validi i vincoli VIETATO e il formato OUTPUT.
${extra}`;
}

interface LinePayload {
  id: string;
  code: string;
  bomCode?: string;
  category: string;
  descriptionEN: string;
  notes?: string;
  highlightGroup?: string;
  indice?: string;
  strutturaDescrizione?: string;
  descrizioneOfferta?: string;
  gestione?: string;
}

function indexByName(indices: SpareIndexRow[]): Map<string, SpareIndexRow> {
  const map = new Map<string, SpareIndexRow>();
  for (const row of indices) {
    map.set(row.indice.trim().toUpperCase(), row);
  }
  return map;
}

function collectLines(
  offer: Offer,
  indices: SpareIndexRow[]
): { payload: LinePayload[]; apply: Array<{ line: ProposalLine }> } {
  const byIndice = indexByName(indices);
  const payload: LinePayload[] = [];
  const apply: Array<{ line: ProposalLine }> = [];
  let n = 0;

  const push = (line: ProposalLine, extra?: Partial<LinePayload>) => {
    n += 1;
    const id = String(n);
    const indice = extra?.indice || line.notes;
    const idx = indice ? byIndice.get(indice.toUpperCase()) : undefined;
    payload.push({
      id,
      code: line.code,
      bomCode: line.bomCode,
      category: line.category,
      descriptionEN: line.descriptionEN || line.descriptionIT || "",
      notes: line.notes,
      highlightGroup: line.highlightGroup,
      indice: idx?.indice ?? extra?.indice,
      strutturaDescrizione: idx?.strutturaDescrizione,
      descrizioneOfferta: idx?.descrizioneOfferta,
      gestione: idx?.gestione,
    });
    apply.push({ line });
  };

  for (const m of offer.machines) {
    for (const l of m.spares) push(l);
    for (const l of m.motors) push(l);
    for (const l of m.sensors) push(l);
  }
  return { payload, apply };
}

function extractJson(text: string): { lines?: { id: string; descriptionEN?: string }[] } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Risposta Claude senza JSON");
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Chiede a Claude di rifinire le descrizioni commerciali sulla bozza già calcolata.
 * In caso di errore/assenza API key lascia l'offerta invariata.
 */
export async function refineOfferWithClaude(
  offer: Offer,
  indices: SpareIndexRow[]
): Promise<Offer> {
  if (!isApiKeyConfigured()) {
    return {
      ...offer,
      meta: {
        ...offer.meta,
        claude: { used: false, reason: "API key mancante" },
      },
    };
  }

  const { payload, apply } = collectLines(offer, indices);
  if (!payload.length) {
    return {
      ...offer,
      meta: { ...offer.meta, claude: { used: false, reason: "nessuna riga" } },
    };
  }

  const userPrompt = `Bozza offerta ricambi Trasmec da rifinire (solo descriptionEN).

Cliente: ${offer.header.customer || "—"}
Progetto: ${offer.header.projectName || "—"}
Ordine: ${offer.header.orderNumber || "—"}

Tabella indici:
${JSON.stringify(
  indices.map((i) => ({
    indice: i.indice,
    descrizioneOfferta: i.descrizioneOfferta,
    gestione: i.gestione,
    strutturaDescrizione: i.strutturaDescrizione,
    sparePartsList: i.sparePartsList,
  })),
  null,
  2
)}

Righe (id da ripetere in output):
${JSON.stringify(payload, null, 2)}`;

  try {
    const text = await askClaude({
      system: systemPrompt(),
      prompt: userPrompt,
      maxTokens: 8192,
    });
    const parsed = extractJson(text);
    const byId = new Map(
      (parsed.lines ?? []).map((l) => [String(l.id), (l.descriptionEN ?? "").trim()])
    );
    let updated = 0;
    for (let i = 0; i < apply.length; i++) {
      const desc = byId.get(String(i + 1));
      if (!desc) continue;
      apply[i].line.descriptionEN = desc;
      updated += 1;
    }
    return {
      ...offer,
      meta: {
        ...offer.meta,
        claude: {
          used: true,
          model: DEFAULT_MODEL,
          linesSent: payload.length,
          linesUpdated: updated,
        },
      },
    };
  } catch (err) {
    return {
      ...offer,
      meta: {
        ...offer.meta,
        claude: {
          used: false,
          model: DEFAULT_MODEL,
          error: err instanceof Error ? err.message : String(err),
        },
      },
    };
  }
}
