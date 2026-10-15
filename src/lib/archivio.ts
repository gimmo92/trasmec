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
  altri: DocumentoFile[];
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

/** Ordini della distinta: scelta manuale, altrimenti i file ordine che citano il suo BE####. */
export function ordiniPerDistinta(
  distinta: DocumentoFile,
  orders: DocumentoFile[],
  saved?: SavedLink
): { ordini: string[]; manual: boolean } {
  if (saved?.manual) return { ordini: alive(saved.ordini, orders), manual: true };
  if (distinta.code) {
    const auto = orders
      .filter((order) => orderCodesOf(order).includes(distinta.code!))
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
  const distinte = files
    .filter((file) => file.kind === "distinta")
    .map((file) => {
      const link = ordiniPerDistinta(file, ordini, saved[file.name]);
      return { ...file, ordini: link.ordini, manual: link.manual };
    });
  const altri = files.filter((file) => file.kind !== "ordine" && file.kind !== "distinta");
  return { ordini, distinte, altri };
}

/** Associa una distinta a uno o più ordini. La scelta resta anche se arrivano altri file. */
export async function associaDistinta(distintaName: string, orderNames: string[]): Promise<ArchivioDistinta> {
  const archivio = await readArchivio();
  const distinta = archivio.distinte.find((file) => file.name === distintaName);
  if (!distinta) throw new Error("Distinta non trovata");
  const wanted = [...new Set(orderNames.map((name) => name.trim()).filter(Boolean))];
  const known = new Set(archivio.ordini.map((order) => order.name));
  if (wanted.some((name) => !known.has(name))) throw new Error("Ordine non trovato");
  if (archivio.ordini.length > 0 && wanted.length === 0) {
    throw new Error("Ogni distinta va associata ad almeno un ordine");
  }
  const links = await loadLinks();
  links[distintaName] = { ordini: wanted, manual: true };
  await saveLinks(links);
  return { ...distinta, ordini: wanted, manual: true };
}
