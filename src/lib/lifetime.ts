import * as XLSX from "xlsx";
import type { ProposalLine } from "./types";

/** Riga del file info dettagli spare parts: categoria e ore di durata. */
export interface WearLifetime {
  en: string;
  it: string;
  hours: number;
}

/** Durate del file Info-Dettagli x SPARE PARTS, usate se in archivio non c'è il foglio. */
const DEFAULT_WEAR_LIFETIMES: WearLifetime[] = [
  { en: "Support TM", it: "Supporto TM", hours: 87600 },
  { en: "Support SN", it: "Supporto SN", hours: 87600 },
  { en: "Bearing", it: "Cuscinetto", hours: 43800 },
  { en: "Sleeve", it: "Bussola", hours: 87600 },
  { en: "Thrust bearing", it: "RALLA", hours: 43800 },
  { en: "Clamping ring", it: "Guarnizione", hours: 26280 },
  { en: "Support Altri", it: "Supporto Altri", hours: 87600 },
  { en: "Kit settori", it: "Kit settori", hours: 87600 },
  { en: "Pinion", it: "Pignone", hours: 17520 },
  { en: "Crown", it: "Corona", hours: 17520 },
  { en: "Transmission chain", it: "Catena di trasmissione", hours: 17520 },
  { en: "Transmission coupling", it: "Giunto di trasmissione", hours: 43800 },
  { en: "Scraper", it: "Pala", hours: 43800 },
  { en: "Transport chain", it: "Catena di trasporto", hours: 26280 },
  { en: "Belt L=XXXXX", it: "Tappeto L=XXXXX", hours: 87600 },
  { en: "Gearmotor", it: "Motoriduttore", hours: 87600 },
  { en: "Sensor (tranne i Vega / Vib)", it: "Sensore (tranne i Vega / Vib)", hours: 87600 },
  { en: "Sensor Vega /Vib", it: "Sensore Vega / Vib", hours: 87600 },
  { en: "Sprinkler", it: "Spruzzatori", hours: 43800 },
  { en: "Explosion proof door", it: "Portelle anti esplosione", hours: 87600 },
];

/** Il file in archivio vince; altrimenti restano le durate già lette da quel foglio. */
export function wearLifetimeTable(fromFile: WearLifetime[]): WearLifetime[] {
  return fromFile.length ? fromFile : DEFAULT_WEAR_LIFETIMES;
}

/** Legge le durate dal foglio info spare parts (colonna estimated lifetime). */
export function readWearLifetimes(filePath: string): WearLifetime[] {
  const wb = XLSX.readFile(filePath, { cellDates: true, cellFormula: false });
  const sheet =
    wb.SheetNames.find((name) => /info\s*spare/i.test(name)) ?? wb.SheetNames[0];
  const ws = sheet ? wb.Sheets[sheet] : undefined;
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  let hoursCol = -1;
  for (const row of rows.slice(0, 15)) {
    for (let c = 0; c < (row?.length ?? 0); c++) {
      const cell = String(row?.[c] ?? "");
      if (/estimated\s+lifetime|durata\s+stimata/i.test(cell)) hoursCol = c;
    }
  }
  if (hoursCol < 0) return [];

  const out: WearLifetime[] = [];
  for (const row of rows) {
    const raw = row?.[hoursCol];
    const hours = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    const texts: string[] = [];
    for (let c = 0; c < hoursCol; c++) {
      const s = String(row?.[c] ?? "").trim();
      if (s.length < 3 || !/[A-Za-z]/.test(s)) continue;
      if (/^(pz|mt|nr)$/i.test(s)) continue;
      texts.push(s);
    }
    if (!texts[0]) continue;
    out.push({ en: texts[0], it: texts[1] ?? "", hours });
  }
  return out;
}

function label(row: WearLifetime): string {
  return `${row.en} ${row.it}`.toLowerCase();
}

function hoursWhere(rows: WearLifetime[], pred: (text: string) => boolean): number | null {
  const hit = rows.find((row) => pred(label(row)));
  return hit ? hit.hours : null;
}

/**
 * Ore di durata della categoria riconosciuta nel file.
 * L'ordine segue le categorie del foglio: il sensore Vega prima del sensore
 * generico, la catena di trasporto prima di quella di trasmissione.
 */
export function wearLifetimeHours(
  line: Pick<
    ProposalLine,
    "code" | "descriptionEN" | "descriptionIT" | "category" | "um" | "notes" | "model"
  >,
  rows: WearLifetime[]
): number | null {
  if (!rows.length) return null;
  const code = (line.code || "").trim();
  const codeU = code.toUpperCase();
  const text = [code, line.descriptionEN, line.descriptionIT, line.notes, line.model]
    .filter(Boolean)
    .join(" ");
  const um = (line.um || "").trim().toUpperCase();

  if (
    line.category === "motor" ||
    /\b(gearmotor|motoriduttore)\b/i.test(text) ||
    /^MR\d/i.test(codeU)
  ) {
    return hoursWhere(rows, (s) => /\b(gearmotor|motoriduttore)\b/.test(s));
  }

  if (
    line.category === "sensor" ||
    /\b(sensor|sensore)\b/i.test(text) ||
    /^SE\d/i.test(codeU)
  ) {
    if (/vega|\bvib\b/i.test(text)) {
      return hoursWhere(rows, (s) => /vega|\bvib\b/.test(s) && !/tranne|except/.test(s));
    }
    return hoursWhere(rows, (s) => /\b(sensor|sensore)\b/.test(s) && !(/vega|\bvib\b/.test(s) && !/tranne|except/.test(s)));
  }

  if (/coupling|giunto/i.test(text)) {
    return hoursWhere(rows, (s) => /coupling|giunto/.test(s));
  }
  if (/\b(belt|tappeto)\b/i.test(text)) {
    return hoursWhere(rows, (s) => /\b(belt|tappeto)\b/.test(s));
  }
  if (/\b(chain|catena)\b/i.test(text)) {
    const transport = /trasport|convey/i.test(text) || um === "MT" || um === "M" || um === "MM";
    return transport
      ? hoursWhere(rows, (s) => /transport|trasporto|convey/.test(s))
      : hoursWhere(rows, (s) => /transmission|trasmissione/.test(s));
  }
  if (/sector|settor/i.test(text)) {
    return hoursWhere(rows, (s) => /sector|settor/.test(s));
  }
  if (/\b(pinion|pignone)\b/i.test(text)) {
    return hoursWhere(rows, (s) => /pinion|pignone/.test(s));
  }
  if (/\b(crown|corona)\b/i.test(text)) {
    return hoursWhere(rows, (s) => /\b(crown|corona)\b/.test(s));
  }
  if (/scraper|\bpala\b|\bpaddle\b|\bscrew\b/i.test(text) || /^CT0003$/i.test(codeU)) {
    return hoursWhere(rows, (s) => /scraper|\bpala\b/.test(s));
  }

  const child = /^cuscinetti\b/i.test(line.notes || "");
  const supportLine =
    !child &&
    (/\bsupporto?\b/i.test(`${line.descriptionEN || ""} ${line.descriptionIT || ""}`) ||
      /^SUP-/i.test(codeU));
  if (supportLine) {
    const blob = `${code} ${text}`;
    if (/\bTM\d|\bTM\b|SUP-TM/i.test(blob)) {
      return hoursWhere(rows, (s) => /support(?:o)?\s*tm\b/.test(s));
    }
    if (/\bSN[LH]?\s*\d|\bSNL|\bSNH|\bUKT|\bFN\s*\d/i.test(text)) {
      return hoursWhere(rows, (s) => /support(?:o)?\s*sn\b/.test(s));
    }
    return hoursWhere(rows, (s) => /support(?:o)?\s*altri\b/.test(s));
  }

  if (/ralla|thrust/i.test(text) || /^RALLA-/i.test(codeU)) {
    return hoursWhere(rows, (s) => /thrust|ralla/.test(s));
  }
  if (/bussola|\bsleeve\b/i.test(text) || /^BUS-/i.test(codeU)) {
    return hoursWhere(rows, (s) => /sleeve|bussola/.test(s));
  }
  if (
    /guarnizion|clamping|sealing|\btenuta\b/i.test(text) ||
    /^ANT-/i.test(codeU) ||
    /\d+\s*\/\s*\d+\s*\/\s*\d+/.test(text)
  ) {
    return hoursWhere(rows, (s) => /clamping|guarnizion/.test(s));
  }
  if (/cuscinett|\bbearing\b/i.test(text) || /^CUS-/i.test(codeU)) {
    return hoursWhere(rows, (s) => /bearing|cuscinetto/.test(s) && !/thrust/.test(s));
  }
  if (/sprinkler|spruzzat/i.test(text)) {
    return hoursWhere(rows, (s) => /sprinkler|spruzz/.test(s));
  }
  if (/explosion|portell|anti\s*esplos/i.test(text)) {
    return hoursWhere(rows, (s) => /explosion|portell/.test(s));
  }
  return null;
}
