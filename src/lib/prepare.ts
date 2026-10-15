import { ensureBucket, useCloud } from "./cloud";
import { hydrateDocumenti } from "./documenti";
import { hydrateIndici } from "./indici";
import { hydrateIstruzioni } from "./istruzioni";
import { hydrateSigle } from "./sigle";

let pending: Promise<void> | null = null;

/** Carica indici, sigle, istruzioni e documenti da Supabase quando le chiavi sono presenti. */
export function prepareApp(): Promise<void> {
  if (!useCloud()) return Promise.resolve();
  if (!pending) {
    pending = (async () => {
      await ensureBucket();
      await hydrateIndici();
      await hydrateSigle();
      await hydrateIstruzioni();
      await hydrateDocumenti();
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}
