import type { MachineSection } from "./types";

/**
 * DESCRIPTION della macchina (colonna H del template): testo da COC o distinta,
 * per esempio "TC 40HP – L=18800".
 */
export function machineLabel(
  m: Pick<MachineSection, "description" | "machineType" | "jobNr">
): string {
  const blob = [m.description, m.machineType].filter(Boolean).join("\n");
  const typed = blob.match(
    /\b([A-Z]{1,5}\s*\d{1,4}\s*[A-Z]{0,4})\s*[–—-]\s*L\s*=\s*(\d+)/i
  );
  if (typed) {
    const name = typed[1].replace(/\s+/g, " ").trim();
    return `${name} – L=${typed[2]}`;
  }
  const len = blob.match(/L\s*=\s*(\d+)/i);
  const type = (m.machineType || "").trim();
  const typeOk = Boolean(type) && !/^B[A-Z]\d{4}$/i.test(type);
  if (typeOk && len && !/L\s*=/i.test(type)) return `${type} – L=${len[1]}`;

  const chunks = (m.description || "")
    .split(/\r?\n| {2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(
      (s) => s.length >= 3 && s.length <= 90 && !/^POS\./i.test(s) && !/^B[A-Z]\d{4}$/i.test(s)
    );
  if (chunks[0]) return chunks[0];
  if (typeOk) return type;
  return (m.description || "").trim() || type || m.jobNr || "";
}

/** Codice macchina e, se c'è nel COC, la posizione: "BF0509 POS. 14.050". */
export function projectLabel(m: Pick<MachineSection, "jobNr" | "itemCode" | "layoutPosition">): string {
  const code = m.jobNr || m.itemCode || "";
  const pos = (m.layoutPosition || "").replace(/^POS\.\s*/i, "").trim();
  if (code && pos) return `${code} POS. ${pos}`;
  return code;
}

/** U.M. dell'offerta: NR o vuoto diventano PZ, come nel template. */
export function offerUnit(um?: string): string {
  if (!um || um.toUpperCase() === "NR") return "PZ";
  return um.toUpperCase();
}
