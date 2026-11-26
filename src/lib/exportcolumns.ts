import { askClaude, isApiKeyConfigured } from "./anthropic";

/** Colonne dell'export Excel dell'offerta lista impianto che le istruzioni possono togliere. */
export const EXPORT_COLUMNS = {
  progressivo: { label: "numero di riga (progressivo)", cols: [6] },
  project: { label: "PROJECT (commessa / POS. del COC)", cols: [7] },
  descrizione_macchina: { label: "DESCRIPTION della macchina (es. TB800 – L=191674), la colonna subito dopo PROJECT", cols: [8] },
  codice: { label: "COD. (codice articolo)", cols: [9] },
  descrizione: { label: "DESCRIPTION del pezzo", cols: [10, 11, 12, 13, 14, 15] },
  um: { label: "U.M", cols: [16] },
  qta_installata: { label: "INSTALLED QTY", cols: [17] },
  start_up: { label: "START UP", cols: [18] },
  qta_suggerita: { label: "SUGGESTED QTY FOR STORAGE", cols: [19] },
  prezzo: { label: "€/EACH (prezzo unitario)", cols: [20] },
  sconto: { label: "% DISCOUNT", cols: [21] },
  totale: { label: "€/TOTAL (NET PRICE)", cols: [22] },
  consegna: { label: "DELIVERY (DAYS)", cols: [23] },
  priorita: { label: "NECESSARY / RECOMMENDED / USEFUL", cols: [24] },
  tipo: { label: "WEAR PART / SPARE PART", cols: [25] },
  durata: { label: "WEAR PARTS ESTIMATED LIFETIME (HRS)", cols: [29] },
} as const;

export type ExportColumn = keyof typeof EXPORT_COLUMNS;

const cache = new Map<string, ExportColumn[]>();

/**
 * Colonne da togliere dall'export secondo le istruzioni personalizzate
 * (es. «esporta in excel senza le prime due colonne project e description»).
 * Claude legge il testo libero; il risultato resta in cache finché il testo non cambia.
 */
export async function colonneDaNascondere(istruzioni: string): Promise<ExportColumn[]> {
  const text = istruzioni.trim();
  if (!text || !/colonn|column/i.test(text) || !isApiKeyConfigured()) return [];
  const cached = cache.get(text);
  if (cached) return cached;
  const elenco = Object.entries(EXPORT_COLUMNS)
    .map(([key, c]) => `- ${key}: ${c.label}`)
    .join("\n");
  const risposta = await askClaude({
    system: `Leggi le istruzioni dell'operatore per l'export Excel di un'offerta ricambi e dici quali colonne togliere.
Colonne dell'Excel, nell'ordine:
${elenco}
Rispondi solo con JSON: {"togli":["chiave", ...]}. Usa solo le chiavi sopra. [] se le istruzioni non chiedono di togliere colonne.`,
    prompt: text,
    maxTokens: 1500,
  });
  const match = risposta.match(/\{[\s\S]*\}/);
  let togli: ExportColumn[] = [];
  if (match) {
    const data = JSON.parse(match[0]) as { togli?: unknown };
    if (Array.isArray(data.togli)) {
      togli = data.togli.filter((k): k is ExportColumn => typeof k === "string" && k in EXPORT_COLUMNS);
    }
  }
  cache.set(text, togli);
  return togli;
}
