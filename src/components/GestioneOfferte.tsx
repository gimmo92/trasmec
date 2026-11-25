"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DOC_KIND_LABEL, FILE_GENERALI, type DocumentoFile, type MachineSection, type Offer, type OffertaStoricoVoce, type ProposalLine } from "@/lib/types";
import { compoundFillIndex, isNonSeSensorLine, supportFillIndex } from "@/lib/highlight";
import { machineLabel, offerUnit, projectLabel } from "@/lib/machinelabel";
import { classifyComponent } from "@/lib/spareclass";

interface Health {
  apiKeyConfigured: boolean;
  model: string;
  documentiDir: string;
}

interface ArchivioDistinta extends DocumentoFile {
  ordini: string[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type LineKind = "spares" | "motors" | "sensors";

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function storicoLabel(item: OffertaStoricoVoce): string {
  return item.orderNumber || item.projectName || item.sourceFile || "Offerta";
}

function formatQty(qty: number | null | undefined): string {
  if (qty === null || qty === undefined) return "";
  return qty.toLocaleString("it-IT", { maximumFractionDigits: 3 });
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return "0,00";
  return value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function priceTitle(line: ProposalLine): string {
  const t = line.priceTrace;
  if (!t) return "Prezzo di vendita";
  if (!t.found) return "Articolo non in YPRIAI00 → prezzo 0";
  const parts = [
    `Base ${formatPrice(t.basePrice)}`,
    `CTM ${t.ctm}${t.ctmFile ? ` (${t.ctmFile})` : ""}`,
    `Magg. ${t.maggiorazione}%${t.maggiorazioneFile ? ` (${t.maggiorazioneFile})` : ""}`,
    `Sconto ${t.sconto}%${t.scontoFile ? ` (${t.scontoFile})` : ""}`,
  ];
  return parts.join(" · ");
}

function LinesTable({
  lines,
  machine,
  start,
  onRemove,
}: {
  lines: ProposalLine[];
  machine: MachineSection;
  start: number;
  onRemove: (index: number) => void;
}) {
  if (!lines.length)
    return <div className="muted-row">— nessuno —</div>;
  const project = projectLabel(machine);
  const description = machineLabel(machine);
  return (
    <table>
      <colgroup>
        <col className="c-n" />
        <col className="c-project" />
        <col className="c-machine" />
        <col className="c-code" />
        <col className="c-desc" />
        <col className="c-um" />
        <col className="c-qty" />
        <col className="c-sug" />
        <col className="c-price" />
        <col className="c-deliv" />
        <col className="c-prio" />
        <col className="c-kind" />
        <col className="c-x" />
      </colgroup>
      <thead>
        <tr>
          <th>N.</th>
          <th>Project</th>
          <th title="Macchina da COC o distinta">Description</th>
          <th>Cod.</th>
          <th title="Descrizione componente">Description</th>
          <th>U.M.</th>
          <th>Installed Qty</th>
          <th>Suggested Qty</th>
          <th title="Prezzo finale YPRI">Prezzo</th>
          <th>Delivery</th>
          <th title="*** NECESSARY  ** RECOMMENDED  * USEFUL">***</th>
          <th title="WEAR PART (W) / SPARE PART (S)">W/S</th>
          <th className="row-del" />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => {
          const supportHue =
            l.highlightGroup === "cuscinetti" ? supportFillIndex(l.compoundHue) : undefined;
          const hue = supportHue === undefined ? compoundFillIndex(l.compoundHue) : undefined;
          const classes = [
            isNonSeSensorLine(l) ? "sensor-other" : "",
            supportHue !== undefined ? `compound-fill support-${supportHue}` : "",
            hue !== undefined ? `compound-fill compound-${hue}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          const info = classifyComponent(l);
          return (
          <tr key={i} className={classes || undefined}>
            <td className="num">{start + i}</td>
            <td>{project}</td>
            <td>{description}</td>
            <td>
              {l.code}
              {l.bomCode ? (
                <span className="dbcode">distinta: {l.bomCode}</span>
              ) : null}
            </td>
            <td>
              {l.descriptionEN || l.descriptionIT || ""}
              {l.atex ? <span className="tag">{l.atex}</span> : null}
            </td>
            <td className="num">{offerUnit(l.um)}</td>
            <td className="num">{formatQty(l.installedQty)}</td>
            <td className="num">{formatQty(l.recommendedQty)}</td>
            <td className="num" title={priceTitle(l)}>
              {formatPrice(l.salePrice ?? 0)}
              {l.discountPct ? (
                <span className="dbcode">−{formatQty(l.discountPct)}%</span>
              ) : null}
            </td>
            <td className="num">{info.deliveryDays ?? ""}</td>
            <td className="num">{info.priority}</td>
            <td className="num">{info.kind}</td>
            <td className="row-del">
              <button
                type="button"
                className="del-row"
                title="Elimina riga"
                aria-label={`Elimina ${l.code}`}
                onClick={() => onRemove(i)}
              >
                ×
              </button>
            </td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MachineBlock({
  m,
  start,
  onRemoveLine,
}: {
  m: MachineSection;
  start: number;
  onRemoveLine: (kind: LineKind, index: number) => void;
}) {
  const pos = (m.layoutPosition || "").replace(/^POS\.\s*/i, "").trim();
  const posLabel = pos ? (/^\d/.test(pos) ? `POS. ${pos}` : pos) : "";
  const title = [m.jobNr, posLabel, m.machineType]
    .filter(Boolean)
    .join("  ·  ");
  return (
    <div className="machine">
      <div className="machine-head">
        <span className="mtitle">{title || m.itemCode}</span>
        {m.atexConfig ? <span className="tag atex">{m.atexConfig}</span> : null}
      </div>
      {m.description ? <div className="mdesc">{m.description}</div> : null}

      <div className="sub">SPARE PARTS ({m.spares.length})</div>
      <LinesTable
        lines={m.spares}
        machine={m}
        start={start}
        onRemove={(i) => onRemoveLine("spares", i)}
      />

      <div className="sub">MOTORS ({m.motors.length})</div>
      <LinesTable
        lines={m.motors}
        machine={m}
        start={start + m.spares.length}
        onRemove={(i) => onRemoveLine("motors", i)}
      />

      <div className="sub">SENSORS ({m.sensors.length})</div>
      <LinesTable
        lines={m.sensors}
        machine={m}
        start={start + m.spares.length + m.motors.length}
        onRemove={(i) => onRemoveLine("sensors", i)}
      />
    </div>
  );
}

export default function GestioneOfferte({ active = true }: { active?: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [docs, setDocs] = useState<DocumentoFile[]>([]);
  const [distinteAll, setDistinteAll] = useState<ArchivioDistinta[]>([]);
  const [listeAll, setListeAll] = useState<ArchivioDistinta[]>([]);
  const [generali, setGenerali] = useState<DocumentoFile[]>([]);
  const [orderPath, setOrderPath] = useState("");
  const [customerCode, setCustomerCode] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [history, setHistory] = useState<OffertaStoricoVoce[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const savedIdRef = useRef<string | null>(null);

  useEffect(() => {
    savedIdRef.current = savedId;
  }, [savedId]);

  const reloadDocs = useCallback(async () => {
    const res = await fetch("/api/archivio");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data.error || "Errore documenti"));
    const orders = (data.ordini ?? []) as DocumentoFile[];
    const boms = (data.distinte ?? []) as ArchivioDistinta[];
    const rest = (data.altri ?? []) as DocumentoFile[];
    setDocs([...orders, ...rest]);
    setDistinteAll(boms);
    setListeAll((data.liste ?? []) as ArchivioDistinta[]);
    setGenerali((data.generali ?? []) as DocumentoFile[]);
    setOrderPath((current) => (orders.some((order) => order.path === current) ? current : ""));
  }, []);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  const reloadHistory = useCallback(async () => {
    const res = await fetch("/api/storico");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data.error || "Errore storico"));
    setHistory(Array.isArray(data.items) ? (data.items as OffertaStoricoVoce[]) : []);
  }, []);

  useEffect(() => {
    if (!active) return;
    reloadDocs()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingDocs(false));
    reloadHistory().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [active, reloadDocs, reloadHistory]);

  const ordini = useMemo(() => docs.filter((d) => d.kind === "ordine"), [docs]);
  const distinte = useMemo(
    () => (orderPath ? distinteAll.filter((d) => d.ordini.includes(orderPath)) : []),
    [distinteAll, orderPath]
  );
  const liste = useMemo(
    () => (orderPath ? listeAll.filter((d) => d.ordini.includes(orderPath)) : []),
    [listeAll, orderPath]
  );
  const offerWarnings = Array.isArray(offer?.meta?.warnings)
    ? (offer.meta.warnings as unknown[]).map(String)
    : [];
  const altri = useMemo(
    () => docs.filter((d) => d.kind !== "ordine" && d.kind !== "distinta" && !FILE_GENERALI.includes(d.kind)),
    [docs]
  );

  const toggle = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const chooseOrder = useCallback((path: string) => {
    setOrderPath(path);
    setSelected(new Set());
    setOffer(null);
    savedIdRef.current = null;
    setSavedId(null);
  }, []);

  const remember = useCallback((item: OffertaStoricoVoce) => {
    savedIdRef.current = item.id;
    setSavedId(item.id);
    setHistory((prev) => [item, ...prev.filter((row) => row.id !== item.id)]);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 2000);
  }, []);

  const persistOffer = useCallback(
    async (next: Offer, id: string | null) => {
      const res = await fetch(id ? `/api/storico/${id}` : "/api/storico", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data.error || "Salvataggio non riuscito"));
      remember(data.item as OffertaStoricoVoce);
    },
    [remember]
  );

  const generate = useCallback(async () => {
    if (!orderPath) {
      setError("Seleziona un'offerta prima di generarla.");
      return;
    }
    // Se c'è già un'offerta per questo ordine (caricata o nello storico), la nuova la sostituisce.
    const orderDoc = ordini.find((doc) => doc.path === orderPath);
    const previousId =
      savedIdRef.current ??
      history.find(
        (row) => row.sourceFile && (row.sourceFile === orderPath || row.sourceFile === orderDoc?.name)
      )?.id ??
      null;
    setGenerating(true);
    setError(null);
    setOffer(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderPath,
          paths: Array.from(selected),
          customerCode: customerCode.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore");
      const next = data.offer as Offer;
      if (next.header.customerCode) setCustomerCode(next.header.customerCode);
      setOffer(next);
      try {
        try {
          await persistOffer(next, previousId);
        } catch (err) {
          // Offerta precedente non più nello storico (es. eliminata altrove): se ne crea una nuova.
          if (!previousId) throw err;
          await persistOffer(next, null);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? `Offerta generata, storico non aggiornato: ${err.message}`
            : "Offerta generata, storico non aggiornato"
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [orderPath, selected, customerCode, persistOffer, ordini, history]);

  const removeLine = useCallback(
    (itemCode: string, kind: LineKind, index: number) => {
      setOffer((prev) => {
        if (!prev) return prev;
        const next: Offer = {
          ...prev,
          machines: prev.machines.map((m) => {
            if (m.itemCode !== itemCode) return m;
            const list = m[kind].filter((_, i) => i !== index);
            return { ...m, [kind]: list };
          }),
        };
        const id = savedIdRef.current;
        if (id) {
          void persistOffer(next, id).catch((err) =>
            setError(err instanceof Error ? err.message : String(err))
          );
        }
        return next;
      });
    },
    [persistOffer]
  );

  const saveCurrent = useCallback(async () => {
    if (!offer) return;
    setSaving(true);
    setError(null);
    try {
      await persistOffer(offer, savedIdRef.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [offer, persistOffer]);

  const openSaved = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/storico/${id}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String(data.error || "Offerta non trovata nello storico"));
        const stored = data.item as { offer: Offer; sourceFile?: string };
        setOffer(stored.offer);
        savedIdRef.current = id;
        setSavedId(id);
        setSelected(new Set());
        const source = stored.sourceFile || "";
        const match = ordini.find((doc) => doc.name === source || doc.path === source);
        setOrderPath(match?.path ?? "");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [ordini]
  );

  const removeSaved = useCallback(
    async (id: string) => {
      const item = history.find((row) => row.id === id);
      const label = item ? storicoLabel(item) : "questa offerta";
      if (!window.confirm(`Eliminare ${label} dallo storico?`)) return;
      setError(null);
      try {
        const res = await fetch(`/api/storico/${id}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(String(data.error || "Eliminazione non riuscita"));
        setHistory((prev) => prev.filter((row) => row.id !== id));
        if (savedIdRef.current === id) {
          savedIdRef.current = null;
          setSavedId(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [history]
  );

  const exportExcel = useCallback(async () => {
    if (!offer) return;
    setExporting(true);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer }),
      });
      if (!res.ok) throw new Error("Errore export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Offerta_Ricambi_${offer.header.orderNumber || "draft"}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [offer]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="status">
          <span className={`dot ${health?.apiKeyConfigured ? "ok" : "bad"}`}></span>
          {health?.apiKeyConfigured
            ? `Claude pronto (${health.model})`
            : "API key Claude mancante (.env.local)"}
        </div>

        <div className="hint">
          Seleziona un&apos;offerta: leggo gli item dopo AFTER SALES e analizzo le distinte
          con quei codici. Con le spunte limiti l&apos;analisi alle distinte scelte.
        </div>
        <div className="doc-list">
          {loadingDocs && <div className="status">Caricamento…</div>}

          <div className="section-title">Storico ({history.length})</div>
          {history.length === 0 && !loadingDocs && (
            <div className="hint">Nessuna offerta salvata. Una generazione resta qui.</div>
          )}
          {history.map((item) => (
            <div
              key={item.id}
              className={`doc ${savedId === item.id ? "selected" : ""}`}
              onClick={() => void openSaved(item.id)}
            >
              <div className="meta">
                <div className="name">{storicoLabel(item)}</div>
                <div className="sub">
                  {[item.customer, formatWhen(item.updatedAt)].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button
                type="button"
                className="storico-del"
                title="Elimina dallo storico"
                aria-label={`Elimina ${storicoLabel(item)} dallo storico`}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeSaved(item.id);
                }}
              >
                ×
              </button>
            </div>
          ))}

          <div className="section-title">Offerte ({ordini.length})</div>
          {ordini.length === 0 && !loadingDocs && (
            <div className="hint">Nessuna offerta riconosciuta.</div>
          )}
          {ordini.map((d) => (
            <div
              key={d.path}
              className={`doc ${orderPath === d.path ? "selected" : ""}`}
              onClick={() => chooseOrder(d.path)}
            >
              <input type="radio" name="ordine" checked={orderPath === d.path} readOnly />
              <div className="meta">
                <div className="name">{d.name}</div>
                <div className="sub">
                  {formatSize(d.sizeBytes)} · caricato il {formatWhen(d.modified)}
                </div>
              </div>
              <span className="badge ordine">offerta</span>
            </div>
          ))}

          <div className="section-title">Distinte base ({distinte.length})</div>
          {!orderPath && !loadingDocs && (
            <div className="hint">Seleziona un&apos;offerta per vedere le distinte.</div>
          )}
          {orderPath && distinte.length === 0 && !loadingDocs && (
            <div className="hint">Nessuna distinta associata a questa offerta.</div>
          )}
          {distinte.map((d) => (
            <div
              key={d.path}
              className={`doc ${selected.has(d.path) ? "selected" : ""}`}
              onClick={() => toggle(d.path)}
            >
              <input type="checkbox" checked={selected.has(d.path)} readOnly />
              <div className="meta">
                <div className="name">{d.name}</div>
                <div className="sub">
                  {d.code && !d.name.toUpperCase().includes(d.code) ? `${d.code} · ` : ""}
                  {formatSize(d.sizeBytes)} · caricato il {formatWhen(d.modified)}
                </div>
              </div>
              <span className="badge distinta">distinta</span>
            </div>
          ))}

          {orderPath && (
            <>
              <div className="section-title">Motori e sensori ({liste.length})</div>
              {liste.length === 0 && !loadingDocs && (
                <div className="hint">Nessuna lista motori o sensori associata a questa offerta.</div>
              )}
              {liste.map((d) => (
                <div key={d.path} className="doc static">
                  <div className="meta">
                    <div className="name">{d.name}</div>
                    <div className="sub">
                      {formatSize(d.sizeBytes)} · caricato il {formatWhen(d.modified)}
                    </div>
                  </div>
                  <span className={`badge ${d.kind}`}>{DOC_KIND_LABEL[d.kind]}</span>
                </div>
              ))}
            </>
          )}

          {generali.length > 0 && (
            <>
              <div className="section-title">File generali ({generali.length})</div>
              {generali.map((d) => (
                <div key={d.path} className="doc static">
                  <div className="meta">
                    <div className="name">{d.name}</div>
                    <div className="sub">
                      {formatSize(d.sizeBytes)} · caricato il {formatWhen(d.modified)}
                    </div>
                  </div>
                  <span className={`badge ${d.kind}`}>{DOC_KIND_LABEL[d.kind]}</span>
                </div>
              ))}
            </>
          )}

          {altri.length > 0 && (
            <>
              <div className="section-title">Altri documenti</div>
              {altri.map((d) => (
                <div key={d.path} className="doc static">
                  <div className="meta">
                    <div className="name">{d.name}</div>
                    <div className="sub">
                      {formatSize(d.sizeBytes)} · caricato il {formatWhen(d.modified)}
                    </div>
                  </div>
                  <span className={`badge ${d.kind}`}>{DOC_KIND_LABEL[d.kind]}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sidebar-actions customer-code">
          <label htmlFor="customer-code">
            Codice cliente
            <input
              id="customer-code"
              type="text"
              inputMode="numeric"
              placeholder="es. 000583"
              value={customerCode}
              onChange={(event) => setCustomerCode(event.target.value)}
              disabled={generating}
            />
          </label>
        </div>
        <div className="sidebar-actions">
          <button
            className="primary"
            style={{ flex: 1 }}
            disabled={generating || !orderPath}
            onClick={generate}
          >
            {generating ? (
              <>
                <span className="spinner" /> Generazione…
              </>
            ) : !orderPath ? (
              "Seleziona un'offerta"
            ) : selected.size > 0 ? (
              `Genera offerta (${selected.size})`
            ) : (
              "Genera offerta"
            )}
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="toolbar">
          <div>
            <h2>Offerta lista impianto</h2>
            <p className="indici-hint">
              Ricambi della lista impianto, quando viene acquistato un nuovo
              impianto.
            </p>
          </div>
          <div className="actions">
            <button onClick={() => void saveCurrent()} disabled={!offer || saving}>
              {saving ? "Salvataggio…" : savedFlash ? "Salvata" : "Salva"}
            </button>
            <button onClick={() => window.print()} disabled={!offer}>
              Stampa / PDF
            </button>
            <button className="primary" onClick={exportExcel} disabled={!offer || exporting}>
              {exporting ? "Esporto…" : "Esporta Excel"}
            </button>
          </div>
        </div>

        {error && <div className="warn">Errore: {error}</div>}

        {offer && (() => {
          const claude = offer.meta?.claude as
            | { used?: boolean; model?: string; error?: string; linesUpdated?: number }
            | undefined;
          if (!claude) return null;
          if (claude.used) {
            return (
              <div className="hint" style={{ padding: "0 0 12px" }}>
                Descrizioni rifinite da Claude ({claude.model}
                {typeof claude.linesUpdated === "number"
                  ? `, ${claude.linesUpdated} righe`
                  : ""}
                ).
              </div>
            );
          }
          return null;
        })()}

        {!offer && !error && (
          <div className="empty">
            Seleziona un&apos;offerta, poi premi <strong>Genera offerta</strong>:
            leggo quel documento, prendo gli item dopo <em>AFTER SALES</em> e
            uso le distinte associate.
          </div>
        )}

        {offer && (
          <div className="offer">
            {offer.meta?.facSimile ? (
              <div className="fac-simile" aria-label="Fac simile">
                FAC SIMILE
              </div>
            ) : null}
            <div className="offer-logos">
              <img src="/logos/trasmec.png" alt="Trasmec" />
              <img src="/logos/tuv-iso9001.png" alt="TÜV SÜD ISO 9001" />
            </div>
            <div className="oh">
              <div>
                <h3>{offer.header.projectName || "OFFERTA RICAMBI"}</h3>
                <div className="kv">
                  Cliente: {offer.header.customer || "—"}
                  {offer.header.customerCode
                    ? ` · cod. ${offer.header.customerCode}`
                    : ""}
                </div>
              </div>
              <div className="kv" style={{ textAlign: "right" }}>
                <div>Ordine n. {offer.header.orderNumber || "—"}</div>
                <div>Data: {offer.header.orderDate || "—"}</div>
              </div>
            </div>

            {offer.machines.length === 0 && (
              <div className="warn">
                Nessuna macchina con distinta disponibile tra gli item dell&apos;offerta.
              </div>
            )}

            {offer.machines.map((m, index) => {
              const start = offer.machines
                .slice(0, index)
                .reduce(
                  (n, prev) => n + prev.spares.length + prev.motors.length + prev.sensors.length,
                  1
                );
              return (
                <MachineBlock
                  key={m.itemCode}
                  m={m}
                  start={start}
                  onRemoveLine={(kind, lineIndex) => removeLine(m.itemCode, kind, lineIndex)}
                />
              );
            })}

            {(offerWarnings.length > 0 || offer.machines.some((m) => m.warnings.length > 0)) && (
              <div className="offer-warnings">
                {offerWarnings.map((w, i) => (
                  <div className="warn small" key={`offer-${i}`}>
                    {w}
                  </div>
                ))}
                {offer.machines.flatMap((m) =>
                  m.warnings.map((w, i) => (
                    <div className="warn small" key={`${m.itemCode}-${i}`}>
                      {[m.jobNr || m.itemCode, w].filter(Boolean).join(" — ")}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
