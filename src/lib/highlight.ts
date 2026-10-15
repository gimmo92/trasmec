import type { ProposalLine } from "./types";

/** Sfondi tenui per gruppi composti nella stessa distinta. */
export const COMPOUND_FILLS = [
  { hex: "#d6e6f5", argb: "FFD6E6F5" },
  { hex: "#f5d6d6", argb: "FFF5D6D6" },
  { hex: "#e6d6f0", argb: "FFE6D6F0" },
  { hex: "#f5e4d0", argb: "FFF5E4D0" },
  { hex: "#d4ebe6", argb: "FFD4EBE6" },
  { hex: "#e8dfd6", argb: "FFE8DFD6" },
] as const;

export function compoundFillIndex(hue: number | undefined): number | undefined {
  if (hue === undefined || hue < 0 || !Number.isFinite(hue)) return undefined;
  return hue % COMPOUND_FILLS.length;
}

/** @deprecated usa compoundFillIndex */
export const compoundBorderIndex = compoundFillIndex;
/** @deprecated usa COMPOUND_FILLS */
export const COMPOUND_BORDERS = COMPOUND_FILLS;

/** True se il codice sensore è un SE standard (SE0010, …). */
export function isStandardSensorCode(code: string | undefined): boolean {
  return /^SE/i.test((code ?? "").trim());
}

/** Item dalla lista sensori il cui codice non inizia con SE (es. PN1006): resta in offerta, evidenziato in giallo. */
export function isNonSeSensorLine(
  line: Pick<ProposalLine, "category" | "code">
): boolean {
  return line.category === "sensor" && !isStandardSensorCode(line.code);
}
