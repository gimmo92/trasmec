"use client";

import { Fragment, useRef, useState, type ReactNode } from "react";

interface RigaRichiesta {
  id: string;
  componente: string;
  quantita: string;
}

interface MailCaricata {
  file: File;
  name: string;
  size: number;
  subject: string;
  /** .msg letto nel browser: si invia questo al posto del file. */
  msg?: {
    subject: string;
    body: string;
    pdf: { name: string; data: Uint8Array }[];
    immagini?: { name: string; data: Uint8Array; type: string }[];
  };
}

/** Codice senza spazi: può andare a capo dopo punti, trattini e barre invece di uscire dalla cella. */
function spezzaCodice(code: string): ReactNode {
  const parts = code.split(/(?<=[./\-_])/);
  if (parts.length < 2) return code;
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? <wbr /> : null}
    </Fragment>
  ));
}

/** Le distinte vanno al server intere: sotto il limite di upload della funzione (~4,5 MB). */
const MAX_EXCEL_SORGENTE = 3 * 1024 * 1024;

function isExcel(name: string): boolean {
  return /\.(xlsx|xlsm|xls)$/i.test(name);
}

/** Il server può rispondere con testo semplice (es. file troppo grande): niente JSON.parse alla cieca. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Foto allegata (es. targhetta) ridotta a JPEG ~1600 px: basta per leggerla e resta leggera da inviare. */
async function rimpicciolisci(data: Uint8Array, type: string): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type }));
    const scala = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scala);
    canvas.height = Math.round(bitmap.height * scala);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85));
  } catch {
    return null;
  }
}

async function leggiRisposta(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413) {
      return { error: "Il file è troppo grande per il server. Prova con una mail senza allegati." };
    }
    return { error: text.trim().slice(0, 200) || `Errore del server (${res.status})` };
  }
}

interface OffertaRiga {
  pos: string;
  articolo: string;
  descrizione: string;
  disegno: string;
  um: string;
  qty: number | null;
  prezzo: number | null;
  sconto: number | null;
  giorni: number | null;
}

interface OffertaCliente {
  numero: string;
  data: string;
  validita: string;
  clienteNome: string;
  clienteIndirizzo: string[];
  destinazione: string;
  incoterm: string;
  redattore: string;
  rifInterno: string;
  rdo: string;
  attenzione: string;
  pagamento: string;
  imballo: string;
  intro: string;
  righe: OffertaRiga[];
  consegna: string;
  avvisi: string[];
  fonti: string[];
}

function fmtQty(value: number | null): string {
  if (value === null) return "";
  return value.toLocaleString("it-IT", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function fmtNum(value: number | null): string {
  if (value === null) return "";
  return value.toLocaleString("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function importoOf(row: OffertaRiga): number | null {
  if (row.prezzo === null || row.qty === null) return null;
  const lordo = row.prezzo * row.qty;
  if (row.sconto === null) return lordo;
  return lordo * (1 - row.sconto / 100);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function subjectFromEml(raw: string): string {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headers = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw.slice(0, 12000);
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const match = unfolded.match(/^Subject:\s*(.*)$/im);
  return match?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

function nuovaRiga(): RigaRichiesta {
  return {
    id: crypto.randomUUID(),
    componente: "",
    quantita: "1",
  };
}

export default function OfferteV2() {
  const [commessa, setCommessa] = useState("");
  const [codiceCliente, setCodiceCliente] = useState("");
  const [redattore, setRedattore] = useState("");
  const [righe, setRighe] = useState<RigaRichiesta[]>(() => [nuovaRiga()]);
  const [mail, setMail] = useState<MailCaricata | null>(null);
  const [mailError, setMailError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [revising, setRevising] = useState(false);
  const [istruzione, setIstruzione] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<OffertaCliente | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sorgenti, setSorgenti] = useState<File[]>([]);
  const [sorgentiError, setSorgentiError] = useState<string | null>(null);
  const sorgentiRef = useRef<HTMLInputElement>(null);

  const aggiungiSorgenti = (list: FileList | null) => {
    setSorgentiError(null);
    const nuovi = Array.from(list ?? []);
    const troppoGrandi = nuovi.filter((file) => isExcel(file.name) && file.size > MAX_EXCEL_SORGENTE);
    if (troppoGrandi.length) {
      setSorgentiError(
        `Distinta troppo grande per il server (max 3 MB): ${troppoGrandi.map((f) => f.name).join(", ")}`
      );
    }
    const validi = nuovi.filter((file) => !troppoGrandi.includes(file));
    setSorgenti((prev) => [
      ...prev.filter((file) => !validi.some((nuovo) => nuovo.name === file.name)),
      ...validi,
    ]);
  };

  const togliSorgente = (name: string) => {
    setSorgenti((prev) => prev.filter((file) => file.name !== name));
    setSorgentiError(null);
  };

  const aggiorna = (id: string, patch: Partial<RigaRichiesta>) => {
    setRighe((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const aggiungi = () => {
    setRighe((prev) => [...prev, nuovaRiga()]);
  };

  const rimuovi = (id: string) => {
    setRighe((prev) => {
      const next = prev.filter((r) => r.id !== id);
      return next.length ? next : [nuovaRiga()];
    });
  };

  const caricaMail = async (file: File | undefined) => {
    setMailError(null);
    if (!file) return;
    const lower = file.name.toLowerCase();
    const isMsg = lower.endsWith(".msg");
    if (!isMsg && !lower.endsWith(".eml")) {
      setMailError("Carica un file .eml o .msg");
      return;
    }
    try {
      if (isMsg) {
        // Il .msg si legge qui: al server vanno solo oggetto e testo, non gli allegati
        // (una mail con allegati supera facilmente il limite di upload del server).
        const { leggiMsg } = await import("@/lib/msgmail");
        const letta = leggiMsg(await file.arrayBuffer());
        setMail({ file, name: file.name, size: file.size, subject: letta.subject, msg: letta });
        return;
      }
      setMail({
        file,
        name: file.name,
        size: file.size,
        subject: subjectFromEml(await file.text()),
      });
    } catch (e) {
      setMailError(e instanceof Error ? e.message : "Impossibile leggere la mail");
    }
  };

  const togliMail = () => {
    setMail(null);
    setMailError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const genera = async () => {
    setGenerating(true);
    setError(null);
    // La nuova offerta sostituisce quella mostrata: niente bozza vecchia durante o dopo un errore.
    setOffer(null);
    try {
      const body = new FormData();
      if (mail?.msg) {
        body.append("emailSubject", mail.msg.subject);
        body.append("emailBody", mail.msg.body);
        for (const pdf of mail.msg.pdf) {
          body.append("allegato", new Blob([pdf.data as BlobPart], { type: "application/pdf" }), pdf.name);
        }
        for (const foto of mail.msg.immagini ?? []) {
          const piccola = await rimpicciolisci(foto.data, foto.type);
          if (piccola) body.append("immagine", piccola, foto.name.replace(/\.\w+$/, ".jpg"));
        }
      } else if (mail) {
        body.append("email", mail.file);
      }
      body.append("commessa", commessa);
      body.append("codiceCliente", codiceCliente);
      body.append("redattore", redattore);
      let pesoPdf = 0;
      for (const file of sorgenti) {
        // Le distinte servono intere, anche quelle PDF scansionate delle matricole vecchie
        // (Claude le legge); dei disegni basta il nome (niente upload pesanti).
        const pdf = /\.pdf$/i.test(file.name) && pesoPdf + file.size <= 3 * 1024 * 1024;
        if (pdf) pesoPdf += file.size;
        if (isExcel(file.name) || pdf) body.append("sorgente", file);
        else body.append("sorgenteNome", file.name);
      }
      body.append(
        "righe",
        JSON.stringify(
          righe.map((riga) => ({
            componente: riga.componente,
            quantita: riga.quantita,
          }))
        )
      );
      const res = await fetch("/api/offerta-cliente", { method: "POST", body });
      const data = await leggiRisposta(res);
      if (!res.ok) throw new Error(data.error || "Errore di generazione");
      setOffer(data.offer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const modifica = async () => {
    if (!offer || !istruzione.trim()) return;
    setRevising(true);
    setError(null);
    try {
      const res = await fetch("/api/offerta-cliente/revisione", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer, istruzione: istruzione.trim() }),
      });
      const data = await leggiRisposta(res);
      if (!res.ok) throw new Error(data.error || "Errore di modifica");
      setOffer(data.offer);
      setIstruzione("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevising(false);
    }
  };

  return (
    <div className="v2-page">
      <div className="v2-head">
        <h2>Offerta richiesta cliente</h2>
        <p className="indici-hint">
          Parte da una richiesta del cliente. Carica la mail oppure inserisci
          commessa, descrizione o codice e quantità: la generazione cerca il
          pezzo nei file sorgente e compila l&apos;offerta ricambi.
        </p>
      </div>

      <form
        className="v2-form"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <div className="v2-mail">
          <span className="v2-mail-label">Mail di richiesta</span>
          <input
            ref={fileRef}
            type="file"
            accept=".eml,.msg,message/rfc822,application/vnd.ms-outlook"
            className="v2-file"
            aria-label="Carica mail"
            onChange={(e) => {
              void caricaMail(e.target.files?.[0]);
            }}
          />
          {mail ? (
            <div className="v2-mail-file">
              <div>
                <div className="v2-mail-name">{mail.name}</div>
                <div className="v2-mail-meta">
                  {formatSize(mail.size)}
                  {mail.subject ? ` · ${mail.subject}` : ""}
                </div>
              </div>
              <button type="button" className="danger" onClick={togliMail}>
                Rimuovi
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()}>
              Carica mail
            </button>
          )}
          {mailError ? <div className="warn small">{mailError}</div> : null}
        </div>

        <div className="v2-mail">
          <span className="v2-mail-label">File sorgente</span>
          <input
            ref={sorgentiRef}
            type="file"
            multiple
            accept=".xlsx,.xlsm,.xls,.dwg,.pdf,.png,.jpg,.jpeg"
            className="v2-file"
            aria-label="Carica file sorgente"
            onChange={(e) => {
              aggiungiSorgenti(e.target.files);
              e.target.value = "";
            }}
          />
          {sorgenti.map((file) => (
            <div className="v2-mail-file" key={file.name}>
              <div>
                <div className="v2-mail-name">{file.name}</div>
                <div className="v2-mail-meta">
                  {formatSize(file.size)} ·{" "}
                  {isExcel(file.name) ? "distinta, letta per i pezzi" : "usato per il numero di disegno"}
                </div>
              </div>
              <button type="button" className="danger" onClick={() => togliSorgente(file.name)}>
                Rimuovi
              </button>
            </div>
          ))}
          <button type="button" onClick={() => sorgentiRef.current?.click()}>
            {sorgenti.length ? "Aggiungi file" : "Carica file sorgente"}
          </button>
          <span className="v2-mail-meta">
            Distinta Excel e disegni del pezzo. Se li carichi, l&apos;offerta usa questi file invece
            di cercarli per ticket o commessa.
          </span>
          {sorgentiError ? <div className="warn small">{sorgentiError}</div> : null}
        </div>

        <div className="v2-field">
          <label htmlFor="v2-cliente">Codice cliente</label>
          <input
            id="v2-cliente"
            value={codiceCliente}
            onChange={(e) => setCodiceCliente(e.target.value)}
            placeholder="Codice YPRI, es. 000438 — per sconto e coefficienti del cliente"
            autoComplete="off"
          />
        </div>

        <div className="v2-field">
          <label htmlFor="v2-redattore">Emesso da</label>
          <input
            id="v2-redattore"
            value={redattore}
            onChange={(e) => setRedattore(e.target.value)}
            placeholder="Nome di chi firma l'offerta"
            autoComplete="name"
          />
        </div>

        <div className="v2-field">
          <label htmlFor="v2-commessa">Numero di commessa</label>
          <input
            id="v2-commessa"
            value={commessa}
            onChange={(e) => setCommessa(e.target.value)}
            placeholder="Es. BE0806C"
            autoComplete="off"
          />
        </div>

        <div className="v2-lines">
          <div className="v2-lines-head">
            <span>Descrizione o codice componente</span>
            <span>Quantità</span>
            <span />
          </div>
          {righe.map((riga, index) => (
            <div className="v2-row" key={riga.id}>
              <input
                aria-label={`Descrizione o codice componente, riga ${index + 1}`}
                value={riga.componente}
                onChange={(e) => aggiorna(riga.id, { componente: e.target.value })}
                placeholder="Descrizione oppure codice"
                autoComplete="off"
              />
              <input
                aria-label={`Quantità, riga ${index + 1}`}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={riga.quantita}
                onChange={(e) => aggiorna(riga.id, { quantita: e.target.value })}
              />
              <button
                type="button"
                className="danger"
                title="Elimina riga"
                aria-label={`Elimina riga ${index + 1}`}
                onClick={() => rimuovi(riga.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="v2-actions">
          <button type="button" onClick={aggiungi}>
            Aggiungi componente
          </button>
          <button
            type="button"
            className="primary"
            disabled={generating}
            onClick={() => void genera()}
          >
            {generating ? "Generazione…" : "Genera offerta"}
          </button>
        </div>
      </form>

      {error && <div className="warn">Errore: {error}</div>}

      {offer && (
        <div className="cliente-wrap">
          <div className="v2-actions">
            <button type="button" onClick={() => window.print()}>
              Stampa / PDF
            </button>
          </div>
          {offer.avvisi.map((avviso) => (
            <div className="warn small" key={avviso}>
              {avviso}
            </div>
          ))}
          {offer.fonti.length > 0 && (
            <p className="indici-hint cliente-fonti">
              File sorgente: {offer.fonti.join(", ")}
            </p>
          )}
          <article className="cliente-offer">
            <header className="co-head">
              <img className="co-logo" src="/logos/trasmec.png" alt="Trasmec" />
              <div className="co-address">
                <div>Via Bergamo 2/A</div>
                <div>26011 CASALBUTTANO ED UNITI (CR) Italia</div>
                <div>Mail: spares@trasmec.com</div>
              </div>
              <div className="co-messrs">
                <div>Messrs</div>
                <strong>{offer.clienteNome || "—"}</strong>
                {offer.clienteIndirizzo.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
              <div className="co-legalrow">
                <img className="co-tuv" src="/logos/tuv-iso9001.png" alt="TÜV SÜD ISO 9001" />
                <div className="co-legal">
                  <div>Tel. 0374364011 / Fax 0374364077</div>
                  <div>Cap. Soc. € 260.000 i.v.</div>
                  <div>Iscritta alla C.C.I.A.A. di Cremona</div>
                  <div>Codice Fiscale e N. Iscrizione Registro Imprese 00119150191</div>
                  <div>Partita IVA IT00119150191 - N.Rea Cr 84707</div>
                </div>
              </div>
            </header>

            <table className="co-meta">
              <colgroup>
                <col className="m-lab" />
                <col className="m-val" />
                <col className="m-lab2" />
                <col className="m-val2" />
                <col className="m-lab3" />
                <col className="m-val3" />
              </colgroup>
              <tbody>
                <tr>
                  <th>Offer number</th>
                  <td>{offer.numero}</td>
                  <th>Date</th>
                  <td>{offer.data}</td>
                  <th>Spare parts offer</th>
                  <td className="c">Page 1 of 1</td>
                </tr>
                <tr>
                  <th>Offer expiry date</th>
                  <td>{offer.validita}</td>
                  <th>Incoterm</th>
                  <td>{offer.incoterm}</td>
                  <th>Destination</th>
                  <td>
                    {offer.destinazione ||
                      [offer.clienteNome, ...offer.clienteIndirizzo].filter(Boolean).join(" ")}
                  </td>
                </tr>
                <tr>
                  <th>Issued by</th>
                  <td>{offer.redattore || "—"}</td>
                  <th>Offer req.</th>
                  <td>{offer.rdo || "—"}</td>
                  <th>Internal ref.</th>
                  <td>{offer.rifInterno || "—"}</td>
                </tr>
                <tr>
                  <th>Kind attn. of:</th>
                  <td>{offer.attenzione || "—"}</td>
                  <th>Payment</th>
                  <td>{offer.pagamento}</td>
                  <th>Packaging</th>
                  <td>{offer.imballo}</td>
                </tr>
              </tbody>
            </table>

            <table className="co-lines">
              <colgroup>
                <col className="w-pos" />
                <col className="w-code" />
                <col className="w-desc" />
                <col className="w-draw" />
                <col className="w-um" />
                <col className="w-qty" />
                <col className="w-price" />
                <col className="w-price" />
                <col className="w-disc" />
                <col className="w-price" />
                <col className="w-days" />
              </colgroup>
              <thead>
                <tr>
                  <th>Pos.</th>
                  <th>Item code</th>
                  <th>Description</th>
                  <th>Drawing nr.</th>
                  <th>U.M.</th>
                  <th>Q.ty</th>
                  <th>Price</th>
                  <th>Total gross price</th>
                  <th>Discount</th>
                  <th>Total net price</th>
                  <th>Delivery work days</th>
                </tr>
              </thead>
              <tbody>
                {offer.righe.map((riga, index) => {
                  const sotto = riga.pos.includes(".");
                  const kit = !sotto && offer.righe.some((other) => other.pos.startsWith(`${riga.pos}.`));
                  const lordo =
                    riga.prezzo !== null && riga.qty !== null
                      ? riga.prezzo * riga.qty
                      : null;
                  return (
                    <tr key={riga.pos} className={sotto ? "co-sub" : kit ? "co-kit" : undefined}>
                      <td className="c">{riga.pos}</td>
                      <td className="co-code">{spezzaCodice(riga.articolo)}</td>
                      <td className="co-desc">
                        {offer.intro && index === 0 ? <div className="co-intro">{offer.intro}</div> : null}
                        {offer.intro && index === 0 ? <div className="co-desc-gap" /> : null}
                        <div>{riga.descrizione}</div>
                      </td>
                      <td className="co-code">{spezzaCodice(riga.disegno)}</td>
                      <td className="c">{riga.um}</td>
                      <td className="c">{fmtQty(riga.qty)}</td>
                      <td className="n">{fmtNum(riga.prezzo)}</td>
                      <td className="n">{fmtNum(lordo)}</td>
                      <td className="n">{fmtNum(riga.sconto)}</td>
                      <td className="n">{fmtNum(importoOf(riga))}</td>
                      <td className="c">{riga.giorni ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <footer className="co-foot">
              <div className="co-sum">
                <span>Total net price : EUR</span>
                <b>
                  {offer.righe.every((riga) => importoOf(riga) === null)
                    ? ""
                    : fmtNum(offer.righe.reduce((sum, riga) => sum + (importoOf(riga) ?? 0), 0))}
                </b>
              </div>

              <div className="co-remark">
                <div>Remark:</div>
                <strong>{offer.consegna}</strong>
              </div>
            </footer>
          </article>

          <form
            className="co-revise"
            onSubmit={(e) => {
              e.preventDefault();
              void modifica();
            }}
          >
            <label htmlFor="co-llm">Modifica l&apos;offerta</label>
            <textarea
              id="co-llm"
              className="istruzioni-input co-llm"
              value={istruzione}
              disabled={revising}
              placeholder="Es. spessore 10 mm, sconto 20% e consegna 45 giorni"
              onChange={(e) => setIstruzione(e.target.value)}
            />
            <div className="v2-actions">
              <button type="submit" className="primary" disabled={revising || !istruzione.trim()}>
                {revising ? "Modifica…" : "Applica con Claude"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
