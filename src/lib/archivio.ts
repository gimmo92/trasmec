import fs from "node:fs";
import path from "node:path";
import { getJson, putJson, useCloud } from "./cloud";
import { listDocumentiClassificati } from "./documenti";
import type { DocumentoFile } from "./types";

const DATA_FILE = path.join(process.cwd(), "data", "archivio.json");
const CLOUD_PATH = "config/archivio.json";

interface SavedLink {
  ordini: string[];
  manual: boolean;
}

export interface ArchivioDistinta extends DocumentoFile {
  /** Nomi dei file ordine a cui la distinta è associata. */
  ordini: string[];
  manual: boolean;
}

export interface Archivio {
  ordini: DocumentoFile[];
  distinte: ArchivioDistinta[];
  /** Liste motori e sensori, collegate agli ordini come le distinte. */
  liste: ArchivioDistinta[];
  altri: DocumentoFile[];
}

const LISTE: DocumentoFile["kind"][] = ["lista-motori", "lista-sensori"];

function isCollegabile(file: DocumentoFile): boolean {
  return file.kind === "distinta" || LISTE.includes(file.kind);
}

let memory: Record<string, SavedLink> | null = null;

function orderCodesOf(order: DocumentoFile): string[] {
  if (order.codes?.length) return order.codes;
  return order.code ? [order.code] : [];
}

function alive(names: string[], orders: DocumentoFile[]): string[] {
  const known = new Set(orders.map((order) => order.name));
  return names.filter((name) => known.has(name));
}

/**
 * Ordini del file: scelta manuale, altrimenti gli ordini che citano la sua commessa
 * (per le liste motori/sensori basta una commessa in comune).
 */
export function ordiniPerDistinta(
  distinta: DocumentoFile,
  orders: DocumentoFile[],
  saved?: SavedLink
): { ordini: string[]; manual: boolean } {
  if (saved?.manual) return { ordini: alive(saved.ordini, orders), manual: true };
  const own = LISTE.includes(distinta.kind)
    ? distinta.codes ?? []
    : distinta.code
      ? [distinta.code]
      : [];
  if (own.length) {
    const auto = orders
      .filter((order) => orderCodesOf(order).some((code) => own.includes(code)))
      .map((order) => order.name);
    if (auto.length) return { ordini: auto, manual: false };
  }
  return { ordini: alive(saved?.ordini ?? [], orders), manual: false };
}

function readLocal(): Record<string, SavedLink> {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Record<string, SavedLink>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function loadLinks(): Promise<Record<string, SavedLink>> {
  if (memory) return memory;
  if (useCloud()) {
    const remote = await getJson<Record<string, SavedLink>>(CLOUD_PATH);
    if (remote && typeof remote === "object" && !Array.isArray(remote)) {
      memory = remote;
      return remote;
    }
  }
  memory = readLocal();
  return memory;
}

async function saveLinks(links: Record<string, SavedLink>): Promise<void> {
  memory = links;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
  if (useCloud()) await putJson(CLOUD_PATH, links);
}

export async function readArchivio(): Promise<Archivio> {
  const files = await listDocumentiClassificati();
  const ordini = files.filter((file) => file.kind === "ordine");
  const saved = await loadLinks();
  const collega = (file: DocumentoFile): ArchivioDistinta => {
    const link = ordiniPerDistinta(file, ordini, saved[file.name]);
    return { ...file, ordini: link.ordini, manual: link.manual };
  };
  const distinte = files.filter((file) => file.kind === "distinta").map(collega);
  const liste = files.filter((file) => LISTE.includes(file.kind)).map(collega);
  const altri = files.filter((file) => file.kind !== "ordine" && !isCollegabile(file));
  return { ordini, distinte, liste, altri };
}

/** Associa una distinta o una lista a uno o più ordini. La scelta resta anche se arrivano altri file. */
export async function associaDistinta(distintaName: string, orderNames: string[]): Promise<ArchivioDistinta> {
  const archivio = await readArchivio();
  const distinta = [...archivio.distinte, ...archivio.liste].find((file) => file.name === distintaName);
  if (!distinta) throw new Error("File non trovato");
  const wanted = [...new Set(orderNames.map((name) => name.trim()).filter(Boolean))];
  const known = new Set(archivio.ordini.map((order) => order.name));
  if (wanted.some((name) => !known.has(name))) throw new Error("Offerta non trovata");
  if (archivio.ordini.length > 0 && wanted.length === 0) {
    throw new Error("Ogni file va associato ad almeno un'offerta");
  }
  const links = await loadLinks();
  links[distintaName] = { ordini: wanted, manual: true };
  await saveLinks(links);
  return { ...distinta, ordini: wanted, manual: true };
}
