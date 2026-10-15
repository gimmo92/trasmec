import fs from "node:fs";
import path from "node:path";
import { cloudTmpDir, downloadFile, listStorage, uploadFile, useCloud } from "./cloud";
import type { DocumentoFile } from "./types";

let dirOverride: string | null = null;

/** Cartella documenti sul disco del progetto (non il mirror in /tmp). */
export function localDocumentiDir(): string {
  const rel = process.env.DOCUMENTI_DIR || "./documenti";
  return path.resolve(process.cwd(), rel);
}

/** Cartella dei documenti di input (locale, oppure copia da Supabase). */
export function getDocumentiDir(): string {
  return dirOverride ?? localDocumentiDir();
}

function isIgnoredFile(name: string): boolean {
  return name.startsWith("~") || name.startsWith(".~") || name.startsWith("~$");
}

function filesIn(dir: string): { name: string; full: string; size: number }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; full: string; size: number }[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (isIgnoredFile(name)) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    out.push({ name, full, size: fs.statSync(full).size });
  }
  return out;
}

/** Se Supabase è configurato, allinea i file locali al bucket e, in cloud, li scarica in /tmp. */
export async function hydrateDocumenti(): Promise<void> {
  if (!useCloud()) {
    dirOverride = null;
    return;
  }
  const local = filesIn(localDocumentiDir());
  const remote = await listStorage("documenti");
  for (const file of local) {
    const known = remote.get(file.name);
    if (known === undefined || (known > 0 && known !== file.size)) {
      await uploadFile(`documenti/${file.name}`, file.full);
      remote.set(file.name, file.size);
    }
  }
  if (local.length > 0) {
    dirOverride = null;
    return;
  }
  const tmp = cloudTmpDir();
  fs.mkdirSync(tmp, { recursive: true });
  for (const [name, size] of remote) {
    const dest = path.join(tmp, name);
    if (fs.existsSync(dest) && (size <= 0 || fs.statSync(dest).size === size)) continue;
    const buf = await downloadFile(`documenti/${name}`);
    if (buf) fs.writeFileSync(dest, buf);
  }
  dirOverride = tmp;
}

/** Classifica un file in base al nome. */
function classify(name: string): DocumentoFile["kind"] {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "template";
  if (n.includes("-ml") || n.includes("motor")) return "lista-motori";
  if (n.includes("-sl") || n.includes("sensor")) return "lista-sensori";
  if (n.includes("spare") || n.includes("listino") || n.includes("price")) return "listino";
  if (/^be\d+/i.test(name) || n.endsWith(".xlsm")) return "distinta";
  if (n.endsWith(".xlsx")) return "distinta";
  return "altro";
}

/** Elenca i file presenti nella cartella documenti (ignora lock/temporanei). */
export function listDocumenti(): DocumentoFile[] {
  const dir = getDocumentiDir();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: DocumentoFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (isIgnoredFile(e.name)) continue;
    const full = path.join(dir, e.name);
    const stat = fs.statSync(full);
    files.push({
      name: e.name,
      path: e.name,
      ext: path.extname(e.name).toLowerCase(),
      sizeBytes: stat.size,
      modified: stat.mtime.toISOString(),
      kind: classify(e.name),
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** Risolve in modo sicuro un path relativo dentro la cartella documenti. */
export function resolveDocumento(relPath: string): string {
  const dir = getDocumentiDir();
  const full = path.resolve(dir, relPath);
  if (!full.startsWith(dir)) {
    throw new Error("Percorso non valido");
  }
  return full;
}
