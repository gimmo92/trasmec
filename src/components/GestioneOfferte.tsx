"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DocumentoFile, MachineSection, Offer, ProposalLine } from "@/lib/types";
import { compoundFillIndex, isNonSeSensorLine } from "@/lib/highlight";

interface Health {
  apiKeyConfigured: boolean;
  model: string;
  documentiDir: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type LineKind = "spares" | "motors" | "sensors";

function LinesTable({
  lines,
  onRemove,
}: {
  lines: ProposalLine[];
  onRemove: (index: number) => void;
}) {
  if (!lines.length)
    return <div className="muted-row">— nessuno —</div>;
  return (
    <table>
      <thead>
        <tr>
          <th style={{ width: "18%" }}>Codice</th>
          <th>Descrizione</th>
          <th style={{ width: "110px" }}>Installed Qty</th>
          <th style={{ width: "150px" }}>Recommended Storage</th>
          <th style={{ width: "50px" }}>U.M.</th>
          <th className="row-del" />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => {
          const hue = compoundFillIndex(l.compoundHue);
          const classes = [
            isNonSeSensorLine(l) ? "sensor-other" : "",
            hue !== undefined ? `compound-fill compound-${hue}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
          <tr key={i} className={classes || undefined}>
            <td>
              {l.code}
              {l.bomCode ? (
                <span className="dbcode">distinta: {l.bomCode}</span>
              ) : null}
            </td>
            <td>
              {l.descriptionIT || l.descriptionEN || ""}
              {l.atex ? <span className="tag">{l.atex}</span> : null}
            </td>
            <td className="num">{l.installedQty}</td>
            <td className="num">{l.recommendedQty ?? ""}</td>
            <td className="num">{l.um || "NR"}</td>
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
  onRemoveLine,
}: {
  m: MachineSection;
  onRemoveLine: (kind: LineKind, index: number) => void;
}) {
  const title = [m.layoutPosition, m.jobNr, m.machineType]
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
      <LinesTable lines={m.spares} onRemove={(i) => onRemoveLine("spares", i)} />

      <div className="sub">MOTORS ({m.motors.length})</div>
      <LinesTable lines={m.motors} onRemove={(i) => onRemoveLine("motors", i)} />

      <div className="sub">SENSORS ({m.sensors.length})</div>
      <LinesTable lines={m.sensors} onRemove={(i) => onRemoveLine("sensors", i)} />
    </div>
  );
}

export default function GestioneOfferte() {
  const [health, setHealth] = useState<Health | null>(null);
  const [docs, setDocs] = useState<DocumentoFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    fetch("/api/documenti")
      .then((r) => r.json())
      .then((d) => setDocs(d.files ?? []))
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingDocs(false));
  }, []);

  const distinte = useMemo(
    () => docs.filter((d) => d.kind === "distinta" && /^BE\d{4}/i.test(d.name)),
    [docs]
  );
  const altri = useMemo(
    () => docs.filter((d) => !(d.kind === "distinta" && /^BE\d{4}/i.test(d.name))),
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

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setOffer(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore");
      setOffer(data.offer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [selected]);

  const removeLine = useCallback(
    (itemCode: string, kind: LineKind, index: number) => {
      setOffer((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          machines: prev.machines.map((m) => {
            if (m.itemCode !== itemCode) return m;
            const list = m[kind].filter((_, i) => i !== index);
            return { ...m, [kind]: list };
          }),
        };
      });
    },
    []
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

        <div className="section-title">
          Distinte base ({distinte.length}) — opzionale
        </div>
        <div className="hint">
          Lascia deselezionato per usare tutti gli item del documento d&apos;ordine
          (dopo AFTER SALES).
        </div>
        <div className="doc-list">
          {loadingDocs && <div className="status">Caricamento…</div>}
          {distinte.map((d) => (
            <div
              key={d.path}
              className={`doc ${selected.has(d.path) ? "selected" : ""}`}
              onClick={() => toggle(d.path)}
            >
              <input type="checkbox" checked={selected.has(d.path)} readOnly />
              <div className="meta">
                <div className="name">{d.name}</div>
                <div className="sub">{formatSize(d.sizeBytes)}</div>
              </div>
              <span className="badge distinta">distinta</span>
            </div>
          ))}

          {altri.length > 0 && (
            <>
              <div className="section-title">Altri documenti</div>
              {altri.map((d) => (
                <div key={d.path} className="doc static">
                  <div className="meta">
                    <div className="name">{d.name}</div>
                    <div className="sub">{formatSize(d.sizeBytes)}</div>
                  </div>
                  <span className={`badge ${d.kind}`}>{d.kind}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="sidebar-actions">
          <button
            className="primary"
            style={{ flex: 1 }}
            disabled={generating}
            onClick={generate}
          >
            {generating ? (
              <>
                <span className="spinner" /> Generazione…
              </>
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
          if (claude.error) {
            return (
              <div className="warn small">
                Claude non ha rifinito le descrizioni: {claude.error}
              </div>
            );
          }
          return null;
        })()}

        {!offer && !error && (
          <div className="empty">
            Premi <strong>Genera offerta</strong>: leggo il documento
            d&apos;ordine, prendo gli item dopo <em>AFTER SALES</em>, estraggo i
            ricambi delle distinte e aggiungo motori e sensori.
          </div>
        )}

        {offer && (
          <div className="offer">
            <div className="offer-logos">
              <img src="/logos/trasmec.png" alt="Trasmec" />
              <img src="/logos/tuv-iso9001.png" alt="TÜV SÜD ISO 9001" />
            </div>
            <div className="oh">
              <div>
                <h3>{offer.header.projectName || "OFFERTA RICAMBI"}</h3>
                <div className="kv">Cliente: {offer.header.customer || "—"}</div>
              </div>
              <div className="kv" style={{ textAlign: "right" }}>
                <div>Ordine n. {offer.header.orderNumber || "—"}</div>
                <div>Data: {offer.header.orderDate || "—"}</div>
              </div>
            </div>

            {offer.machines.length === 0 && (
              <div className="warn">
                Nessuna macchina con distinta disponibile tra gli item dell&apos;ordine.
              </div>
            )}

            {offer.machines.map((m) => (
              <MachineBlock
                key={m.itemCode}
                m={m}
                onRemoveLine={(kind, index) => removeLine(m.itemCode, kind, index)}
              />
            ))}

            {offer.machines.some((m) => m.warnings.length > 0) && (
              <div className="offer-warnings">
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
