import fs from "node:fs";
import path from "node:path";
import {
  cloudTmpDir,
  downloadFile,
  listStorage,
  uploadFile,
  useCloud,
} from "./cloud";
import {
  cachedKind,
  ensureClassificazioni,
  kindFromName,
  type ClassifiedDoc,
} from "./classify";
import type { DocumentoFile } from "./types";

let dirOverride: string | null = null;

const ALLOWED_EXT = new Set([".pdf", ".xlsx", ".xlsm", ".xls", ".dwg"]);

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
  return (
    name.startsWith("~") ||
    name.startsWith(".~") ||
    name.startsWith("~$") ||
    name.startsWith(".")
  );
}

function filesIn(dir: string): { name: string; full: string; size: number; mtimeMs: number }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { name: string; full: string; size: number; mtimeMs: number }[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (isIgnoredFile(name)) continue;
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const stat = fs.statSync(full);
    out.push({ name, full, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return out;
}

function canWrite(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Dove salvare un upload: la cartella di progetto, oppure /tmp se il disco è in sola lettura. */
export function writableDocumentiDir(): string {
  const local = localDocumentiDir();
  if (canWrite(local)) return local;
  const tmp = cloudTmpDir();
  fs.mkdirSync(tmp, { recursive: true });
  dirOverride = tmp;
  return tmp;
}

function collectFiles(): { name: string; full: string; size: number; mtimeMs: number }[] {
  const byName = new Map<string, { name: string; full: string; size: number; mtimeMs: number }>();
  for (const file of filesIn(localDocumentiDir())) byName.set(file.name, file);
  if (dirOverride) {
    for (const file of filesIn(dirOverride)) byName.set(file.name, file);
  }
  return [...byName.values()];
}

/** Se Supabase è configurato, allinea i file locali al bucket e scarica quelli caricati online. */
export async function hydrateDocumenti(): Promise<void> {
  if (!useCloud()) {
    dirOverride = null;
    return;
  }
  const localDir = localDocumentiDir();
  const writable = canWrite(localDir) ? localDir : cloudTmpDir();
  fs.mkdirSync(writable, { recursive: true });
  if (writable !== localDir) dirOverride = writable;

  const remote = await listStorage("documenti");
  const present = filesIn(writable);
  for (const file of present) {
    const known = remote.get(file.name);
    if (known === undefined || (known > 0 && known !== file.size)) {
      await uploadFile(`documenti/${file.name}`, file.full);
      remote.set(file.name, file.size);
    }
  }
  for (const [name, size] of remote) {
    if (isIgnoredFile(name)) continue;
    const dest = path.join(writable, name);
    if (fs.existsSync(dest) && (size <= 0 || fs.statSync(dest).size === size)) continue;
    const buf = await downloadFile(`documenti/${name}`);
    if (buf) fs.writeFileSync(dest, buf);
  }
}

export function safeDocumentoName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, "_").trim();
  const ext = path.extname(base).toLowerCase();
  if (!base || base.startsWith(".") || !ALLOWED_EXT.has(ext)) {
    throw new Error("Carica un PDF, un Excel (.xlsx, .xlsm, .xls) o un disegno DWG");
  }
  return base;
}

function toDocumento(
  file: { name: string; size: number; mtimeMs: number },
  meta: ClassifiedDoc
): DocumentoFile {
  return {
    name: file.name,
    path: file.name,
    ext: path.extname(file.name).toLowerCase(),
    sizeBytes: file.size,
    modified: new Date(file.mtimeMs).toISOString(),
    kind: meta.kind,
    code: meta.code,
    codes: meta.codes,
  };
}

/** Elenca i file e classifica quelli nuovi in base al contenuto. */
export async function listDocumentiClassificati(): Promise<DocumentoFile[]> {
  const files = collectFiles();
  await ensureClassificazioni(files);
  return files
    .map((file) =>
      toDocumento(file, cachedKind(file.name, file.size, file.mtimeMs) ?? kindFromName(file.name))
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Elenco già classificato. Se la cache non c'è ancora, usa solo il nome. */
export function listDocumenti(): DocumentoFile[] {
  return collectFiles()
    .map((file) =>
      toDocumento(file, cachedKind(file.name, file.size, file.mtimeMs) ?? kindFromName(file.name))
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Salva un file caricato e lo classifica. */
export async function saveDocumento(
  originalName: string,
  data: Buffer,
  options?: { alreadyInCloud?: boolean }
): Promise<DocumentoFile> {
  if (data.length === 0) throw new Error("Il file è vuoto");
  if (data.length > 40 * 1024 * 1024) throw new Error("Il file supera 40 MB");
  const name = safeDocumentoName(originalName);
  const dir = writableDocumentiDir();
  const full = path.join(dir, name);
  fs.writeFileSync(full, data);
  if (useCloud() && !options?.alreadyInCloud) {
    await uploadFile(`documenti/${name}`, full);
  }
  const stat = fs.statSync(full);
  await ensureClassificazioni([
    ...collectFiles().filter((file) => file.name !== name),
    { name, full, size: stat.size, mtimeMs: stat.mtimeMs },
  ]);
  const meta = cachedKind(name, stat.size, stat.mtimeMs) ?? kindFromName(name);
  return toDocumento({ name, size: stat.size, mtimeMs: stat.mtimeMs }, meta);
}

/** Risolve in modo sicuro un path relativo dentro la cartella documenti. */
export function resolveDocumento(relPath: string): string {
  const name = path.basename(relPath);
  if (!name || name !== relPath.replace(/\\/g, "/")) {
    throw new Error("Percorso non valido");
  }
  const roots = [dirOverride, localDocumentiDir()].filter((dir): dir is string => Boolean(dir));
  for (const dir of roots) {
    const full = path.resolve(dir, name);
    if (!full.startsWith(dir)) throw new Error("Percorso non valido");
    if (fs.existsSync(full)) return full;
  }
  throw new Error("File non trovato");
}
