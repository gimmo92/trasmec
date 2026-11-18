import fs from "node:fs";
import path from "node:path";
import { getJson, putJson, useCloud } from "./cloud";

const DATA_FILE = path.join(process.cwd(), "data", "istruzioni.json");
const CLOUD_PATH = "config/istruzioni.json";

let cache: string | null = null;
let fromCloud = false;
/** Le scritture in corso non vanno coperte da una rilettura cloud più vecchia. */
let epoch = 0;
let writing = 0;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function readFile(): string {
  if (!fs.existsSync(DATA_FILE)) return "";
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as {
      text?: unknown;
    };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function writeFile(value: string) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify({ text: value }, null, 2), "utf8");
  } catch (err) {
    if (!useCloud()) throw err;
  }
}

/** Istruzioni libere dell'operatore, usate in generazione offerta. */
export function getIstruzioni(): string {
  if (fromCloud && cache !== null) return cache;
  if (cache !== null) return cache;
  cache = readFile();
  return cache;
}

export async function hydrateIstruzioni(): Promise<void> {
  if (!useCloud()) {
    cache = readFile();
    fromCloud = false;
    return;
  }
  const seen = epoch;
  const remote = await getJson<{ text?: unknown }>(CLOUD_PATH);
  if (seen !== epoch || writing > 0) return;
  if (remote && typeof remote.text === "string") {
    cache = remote.text;
    fromCloud = true;
    writeFile(remote.text);
    return;
  }
  const local = readFile();
  cache = local;
  fromCloud = true;
  await putJson(CLOUD_PATH, { text: local });
}

export async function setIstruzioni(text: string): Promise<string> {
  return enqueue(async () => {
    const value = String(text ?? "");
    writing += 1;
    epoch += 1;
    cache = value;
    fromCloud = useCloud();
    try {
      writeFile(value);
      if (useCloud()) await putJson(CLOUD_PATH, { text: value });
    } finally {
      writing -= 1;
    }
    return value;
  });
}

/** True se le istruzioni chiedono di mettere FAC SIMILE in cima all'offerta. */
export function wantsFacSimile(text = getIstruzioni()): boolean {
  return /fac\s*[- ]?simil/i.test(text);
}
