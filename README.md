# Trasmec — Generatore Offerte AI

Applicazione locale che legge le **distinte base** (Excel) e genera automaticamente
un'**offerta** con l'aiuto dell'AI (Claude), mostrandone un'**anteprima** ed esportandola.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript** — UI e API in un unico progetto locale
- **Claude** (`@anthropic-ai/sdk`) — generazione/descrizione contenuti offerta
- **xlsx** (SheetJS) — lettura distinte base `.xlsx` / `.xlsm`
- **exceljs** — export dell'offerta in Excel

## Requisiti

- Node.js 18+ (testato con Node 24)
- Una API key di Claude (Anthropic)

## Setup

1. Installa le dipendenze:

```bash
npm install
```

2. Configura la API key in `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

3. Avvia in locale:

```bash
npm run dev
```

4. Apri http://localhost:3000

## Algoritmo di creazione dell'offerta

L'offerta è una **proposta di ricambi** per vari macchinari. Premendo **Genera
offerta ricambi**:

1. **Documento d'ordine (PDF)** — viene letto il PDF in `documenti/`. Si prendono
   gli item d'ordine (`BE####`) **solo dopo la voce "AFTER SALES"** (le prime voci
   — GENERAL, LOADING, PACKAGING, AFTER SALES — sono di servizio e vengono escluse).
2. **Distinte base** — per ogni item si cerca la distinta corrispondente
   (`BE####C-*.xlsx/.xlsm`) e se ne estraggono i **ricambi**: solo i part number i
   cui **primi due caratteri** sono tra:
   `SC, RN, SA, SP, TP, CA, R0, CT, CU, C0`.
3. **Codice vendibile** — il codice mostrato nella proposta non è quello della
   distinta ma il **codice vendibile** (colonna `CODICE`/giallo) preso da
   `Spare Parts List 2026.xlsx`. L'indice mappa `DISEGNO`/`CODICE D.B.` →
   `CODICE`/`CODICE TRASMEC` scandendo tutti i fogli (supporti, tenute, rulli,
   giunti, maglie…). Se un codice non è a listino, si mantiene quello di distinta
   con un avviso ("no listino").
4. **Motori e sensori** — dopo i ricambi di ogni distinta vengono aggiunti i
   **motori** (file `...-ML.xlsx`) e i **sensori** (file `...-SL.xlsx`) associati a
   quella distinta (match tramite il codice job `BE####C`).
5. **Quantità** — colonna **Installed Qty** = quantità in distinta; **Recommended
   Storage** = 10% dell'installato (arrotondato per eccesso, minimo 1).
6. **Anteprima ed export** — l'offerta è mostrata in anteprima raggruppata per
   macchina (Spare Parts / Motors / Sensors) ed esportabile in **Excel** o in **PDF**
   (Stampa / PDF).

> I **prezzi** non sono ancora gestiti (colonne Prezzo/Totale lasciate vuote).
> Le distinte in formato "scheda di configurazione" (es. TKK) non espongono una
> lista ricambi strutturata: la sezione Spare Parts risulterà vuota con un avviso.

## Struttura del progetto

```
documenti/                 # input: distinte base, liste motori/sensori, listino, template
src/
  app/
    page.tsx               # UI principale (selezione, anteprima, export)
    layout.tsx
    globals.css
    api/
      health/route.ts      # stato: API key, modello, cartella documenti
      documenti/route.ts   # elenco file in documenti/
      parse/route.ts       # parsing di una distinta base -> JSON (debug)
      generate/route.ts    # genera l'offerta ricambi (PDF + BOM + ML + SL)
      export/route.ts      # export offerta in Excel
  lib/
    types.ts               # modelli dati (BOM, Offerta ricambi)
    excel.ts               # parser Excel distinte + estrazione ricambi (prefissi)
    motorsensor.ts         # parser liste motori (ML) e sensori (SL)
    orderpdf.ts            # parser documento d'ordine PDF (item dopo AFTER SALES)
    offer.ts               # orchestrazione offerta ricambi
    documenti.ts           # elenco/risoluzione file documenti
    anthropic.ts           # client Claude (per usi futuri: descrizioni/prezzi AI)
```

## Stato attuale

- ✅ Lettura documento d'ordine PDF ed esclusione voci di servizio (fino ad AFTER SALES)
- ✅ Estrazione ricambi dalle distinte con filtro per prefisso part number
- ✅ Aggiunta motori (ML) e sensori (SL) per distinta
- ✅ Installed Qty + Recommended Storage (10%)
- ✅ Anteprima raggruppata per macchina + export Excel + stampa PDF

⏳ **Prossimi passi:** gestione **prezzi** (listino `Spare Parts List 2026.xlsx`),
ricambi per distinte in formato "scheda di configurazione" (TKK), eventuali
descrizioni/arricchimenti via Claude.
