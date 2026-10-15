// Modelli dati condivisi tra server e client.

/** Intestazione (dati generali) di una distinta base. */
export interface BomHeader {
  jobNr?: string; // es. BE0806C
  serialNumber?: string; // es. BE0806C-C010270 (plate nr / matricola)
  machineCode?: string; // es. C010270 / TKK40 BRZ STD-C
  conveyorCategory?: string; // es. COC, TKK, TN
  sizeType?: string; // es. CP 700 S
  description?: string; // descrizione macchina
  customer?: string; // es. SOBONO ENERGY
  finalCustomer?: string;
  plant?: string; // es. Energy Plant
  orderConfirmation?: string; // es. IT0012025COC00050
  customerOrder?: string; // es. T22007-BM-SGP-CSV
  projectNr?: string; // es. IT0012025TRT00044 (TRT)
  layoutPosition?: string; // es. TM F01
  atexConfig?: string; // es. STD / ATEX
  year?: string;
  dateReleased?: string;
  [key: string]: string | undefined;
}

/** Singola riga della distinta base (componente). */
export interface BomRow {
  item?: string; // es. 1, 1.1, 2.3
  partNumber?: string;
  rev?: string;
  descriptionEN?: string;
  descriptionIT?: string;
  qty?: number | string;
  mass?: string;
  sparePart?: string;
  objectType?: string; // Purchased, Welded assembly, Sheet-metal...
  thickness?: string;
  material?: string;
  um?: string;
  /** Distinta base TKK (scheda config): niente filtro sigle sul part number. */
  source?: string;
  [key: string]: string | number | undefined;
}

/** Sintesi di un foglio Excel (per debug/anteprima). */
export interface SheetSummary {
  name: string;
  rows: number;
  cols: number;
}

/** Distinta base completa parsata da un file Excel. */
export interface ParsedBom {
  file: string; // nome file
  path: string; // path relativo a DOCUMENTI_DIR
  format: "structured" | "config" | "unknown";
  sheets: SheetSummary[];
  header: BomHeader;
  bom: BomRow[];
  /** Note/warning generati durante il parsing. */
  warnings: string[];
}

/** Un file presente nella cartella documenti. */
export interface DocumentoFile {
  name: string;
  path: string; // relativo a DOCUMENTI_DIR
  ext: string;
  sizeBytes: number;
  modified: string; // ISO
  kind:
    | "distinta"
    | "ordine"
    | "disegno"
    | "lista-motori"
    | "lista-sensori"
    | "listino"
    | "template"
    | "altro";
  /** Codice commessa BE####, se riconosciuto dentro il file. */
  code?: string;
  /** Codici BE#### citati dall'ordine (dopo AFTER SALES, se c'è). */
  codes?: string[];
}

export const DOC_KIND_LABEL: Record<DocumentoFile["kind"], string> = {
  distinta: "distinta",
  ordine: "ordine",
  disegno: "disegno",
  "lista-motori": "lista motori",
  "lista-sensori": "lista sensori",
  listino: "listino",
  template: "template",
  altro: "da verificare",
};

/** Categoria di una riga di proposta ricambi. */
export type LineCategory = "spare" | "motor" | "sensor";

/** Riga della proposta (ricambio / motore / sensore). */
export interface ProposalLine {
  code: string; // codice da mostrare (vendibile se mappato, altrimenti distinta)
  bomCode?: string; // codice originale della distinta (se diverso dal vendibile)
  mapped?: boolean; // true se trovato un codice vendibile nel listino
  descriptionEN?: string;
  descriptionIT?: string;
  installedQty: number; // quantità installata (da distinta/ML/SL)
  /** Scorta consigliata (10% di installedQty). Null = vuota (assieme supporto). */
  recommendedQty: number | null;
  um?: string; // unità di misura (NR)
  category: LineCategory;
  material?: string;
  mass?: string;
  supplier?: string;
  model?: string;
  power?: string; // per i motori (kW)
  motorType?: string;
  atex?: string;
  notes?: string;
  /** Pezzo + componenti gialli del listino (gruppo assieme). */
  highlightGroup?: "cuscinetti";
  /** Indice del gruppo composto nella stessa distinta (bordo colore). */
  compoundHue?: number;
}

/** Sezione di una macchina (distinta) nell'offerta. */
export interface MachineSection {
  itemCode: string; // es. BE0806 (dall'ordine)
  jobNr?: string; // es. BE0806C
  layoutPosition?: string; // es. TM F01
  machineType?: string; // es. CP 700 S / TKK40 BRZ...
  description?: string;
  atexConfig?: string;
  bomFile?: string;
  spares: ProposalLine[];
  motors: ProposalLine[];
  sensors: ProposalLine[];
  warnings: string[];
}

/** Intestazione dell'offerta (dal documento d'ordine). */
export interface OfferHeader {
  projectName?: string; // es. REXUS BIOMASS ENERGY PLANT - SINGAPORE
  refProject?: string;
  customer?: string; // es. SOBONO ENERGY PTE LTD
  orderNumber?: string; // es. IT00125COC00050
  orderDate?: string;
  location?: string;
  currency?: string;
}

/** Offerta ricambi completa (anteprima + export). */
export interface Offer {
  header: OfferHeader;
  machines: MachineSection[];
  meta?: Record<string, unknown>;
}

/** Flag SI/NO per presenza nel Spare Parts List. */
export type SparePartsFlag = "SI" | "NO";

/** Prefisso part number del filtro 1 (sigle spare parts). */
export interface SpareSiglaRow {
  id: string;
  n: number;
  sigla: string;
}

/** Riga della tabella Indici dei ricambi. `n` è il numero visibile (può ripetersi). */
export interface SpareIndexRow {
  id: string;
  n: number;
  indice: string;
  descrizioneOfferta: string;
  gestione: string;
  sparePartsList: SparePartsFlag;
  strutturaDescrizione: string;
  note: string;
}
