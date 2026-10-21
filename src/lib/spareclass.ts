import type { ProposalLine } from "./types";

/** Classificazione da INFO_SPARE PARTS.xlsx (foglio INFO_SPARE PARTS). */
export interface SpareClass {
  deliveryDays: number | null;
  /** * useful, ** recommended, *** necessary. Vuoto se il file non lo indica. */
  priority: "" | "*" | "**" | "***";
  /** W wear part, S spare part. Vuoto se il file non lo indica. */
  kind: "" | "W" | "S";
}

const EMPTY: SpareClass = { deliveryDays: null, priority: "", kind: "" };

function row(
  deliveryDays: number | null,
  priority: SpareClass["priority"],
  kind: SpareClass["kind"]
): SpareClass {
  return { deliveryDays, priority, kind };
}

/**
 * Tre colonne in coda al componente, in base al tipo descritto nel file:
 * delivery days, *** / ** / *, wear (W) o spare (S).
 * Sprinkler e portelle non hanno valori nel file: restano vuoti.
 * La pala ha solo ***.
 */
export function classifyComponent(
  line: Pick<
    ProposalLine,
    "code" | "descriptionEN" | "descriptionIT" | "category" | "um" | "notes" | "model"
  >
): SpareClass {
  const code = (line.code || "").trim();
  const text = [code, line.descriptionEN, line.descriptionIT, line.notes, line.model]
    .filter(Boolean)
    .join(" ");
  const codeU = code.toUpperCase();
  const um = (line.um || "").trim().toUpperCase();

  if (
    line.category === "motor" ||
    /\b(gearmotor|motoriduttore)\b/i.test(text) ||
    /^MR\d/i.test(codeU)
  ) {
    return row(60, "***", "S");
  }

  if (
    line.category === "sensor" ||
    /\b(sensor|sensore)\b/i.test(text) ||
    /^SE\d/i.test(codeU)
  ) {
    return /vega|\bvib\b/i.test(text) ? row(30, "***", "S") : row(10, "***", "S");
  }

  if (/coupling|giunto/i.test(text)) return row(30, "*", "W");
  if (/\b(belt|tappeto)\b/i.test(text)) return row(60, "***", "W");

  if (/\b(chain|catena)\b/i.test(text)) {
    if (/trasport|convey/i.test(text) || um === "MT" || um === "M" || um === "MM") {
      return row(60, "***", "W");
    }
    return row(5, "***", "W");
  }

  if (/sector|settor/i.test(text)) return row(20, "***", "W");
  if (/\b(pinion|pignone)\b/i.test(text)) return row(30, "*", "S");
  if (/\b(crown|corona)\b/i.test(text)) return row(30, "*", "S");
  if (/scraper|\bpala\b|\bpaddle\b|\bscrew\b/i.test(text) || /^CT0003$/i.test(codeU)) {
    return row(null, "***", "");
  }

  const child = /^cuscinetti\b/i.test(line.notes || "");
  const supportLine =
    !child &&
    (/\bsupporto?\b/i.test(`${line.descriptionEN || ""} ${line.descriptionIT || ""}`) ||
      /^SUP-/i.test(codeU));
  if (supportLine) {
    if (/\bTM\d|\bTM\b|SUP-TM/i.test(`${code} ${text}`)) return row(30, "*", "S");
    if (/\bSN[LH]?\s*\d|\bSNL|\bSNH|\bUKT|\bFN\s*\d/i.test(text)) return row(20, "**", "S");
    return EMPTY;
  }

  if (/ralla|thrust/i.test(text) || /^RALLA-/i.test(codeU)) return row(20, "***", "W");
  if (/bussola|\bsleeve\b/i.test(text) || /^BUS-/i.test(codeU)) return row(20, "***", "W");
  if (
    /guarnizion|clamping|sealing|\btenuta\b/i.test(text) ||
    /^ANT-/i.test(codeU) ||
    /\d+\s*\/\s*\d+\s*\/\s*\d+/.test(text)
  ) {
    return row(20, "***", "W");
  }
  if (/cuscinett|\bbearing\b/i.test(text) || /^CUS-/i.test(codeU)) return row(20, "***", "W");

  return EMPTY;
}
