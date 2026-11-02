import type { MachineSection } from "./types";

/** Sigle macchina: si sostituiscono solo le lettere, il resto del nome resta. */
export function expandMachineFamily(label: string): string {
  return label
    .replace(/\bSRD(?![A-Za-z])/gi, "SLIDE")
    .replace(/\bSR(?![A-Za-z])/gi, "SLIDE")
    .replace(/\bCLP(?![A-Za-z])/gi, "FLAP")
    .replace(/\bCL(?![A-Za-z])/gi, "FLAP")
    .replace(/\bCOC(?![A-Za-z])/gi, "SCREW");
}

/** Lunghezza sulla riga commessa del COC: "L=18800" o "L=6150+6150". */
function cocLength(description?: string): string | undefined {
  const m = (description || "").match(/L\s*=\s*(\d+(?:\s*\+\s*\d+)*)/i);
  return m?.[1].replace(/\s+/g, "");
}

/**
 * Prima DESCRIPTION (colonna H): tipo macchina letto in distinta e, se c'è,
 * la lunghezza della riga commessa nel COC. Esempio "TKK40 BRZ STD-C – L=22000".
 */
export function machineLabel(
  m: Pick<MachineSection, "description" | "machineType" | "jobNr">
): string {
  return expandMachineFamily(machineLabelRaw(m));
}

function machineLabelRaw(
  m: Pick<MachineSection, "description" | "machineType" | "jobNr">
): string {
  const type = (m.machineType || "").trim();
  const typeOk = Boolean(type) && !/^B[A-Z]\d{4}$/i.test(type);
  const len = cocLength(m.description);
  if (typeOk) {
    if (/L\s*=/i.test(type) || !len) return type;
    return `${type} – L=${len}`;
  }

  const blob = m.description || "";
  const typed = blob.match(
    /\b([A-Z]{1,5}\s*\d{1,4}\s*[A-Z]{0,4})\s*[–—-]\s*L\s*=\s*(\d+)/i
  );
  if (typed) {
    const name = typed[1].replace(/\s+/g, " ").trim();
    return `${name} – L=${typed[2]}`;
  }
  if (len) {
    const chunks = blob
      .split(/\r?\n| {2,}/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => s && !/L\s*=/i.test(s) && !/^B[A-Z]\d{4}$/i.test(s));
    const name = chunks[0]?.replace(/\s*[–—-]\s*$/, "").trim();
    if (name) return `${name} – L=${len}`;
  }

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
