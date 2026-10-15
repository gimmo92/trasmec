import fs from "node:fs";
import path from "node:path";
import { getJson, putJson, useCloud } from "./cloud";

const DATA_FILE = path.join(process.cwd(), "data", "istruzioni.json");
const CLOUD_PATH = "config/istruzioni.json";

let cache: string | null = null;
let fromCloud = false;

function readFile(): string {
  if (cache !== null) return cache;
  if (!fs.existsSync(DATA_FILE)) {
    cache = "";
    return cache;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as {
      text?: unknown;
    };
    cache = typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    cache = "";
  }
  return cache;
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
  return readFile();
}

export async function hydrateIstruzioni(): Promise<void> {
  const remote = await getJson<{ text?: unknown }>(CLOUD_PATH);
  if (remote && typeof remote.text === "string") {
    cache = remote.text;
    fromCloud = true;
    return;
  }
  const local = readFile();
  cache = local;
  fromCloud = true;
  await putJson(CLOUD_PATH, { text: local });
}

export async function setIstruzioni(text: string): Promise<string> {
  const value = String(text ?? "");
  cache = value;
  fromCloud = useCloud();
  writeFile(value);
  if (useCloud()) await putJson(CLOUD_PATH, { text: value });
  return value;
}
