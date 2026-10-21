"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DOC_KIND_LABEL, type DocumentoFile, type MachineSection, type Offer, type ProposalLine } from "@/lib/types";
import { compoundFillIndex, isNonSeSensorLine } from "@/lib/highlight";
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

function withUnit(qty: number | null | undefined, um?: string): string {
  if (qty === null || qty === undefined) return "";
  return `${qty.toLocaleString("it-IT", { maximumFractionDigits: 3 })} ${(um || "NR").toUpperCase()}`;
}

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
          <th style={{ width: "80px" }}>Delivery</th>
          <th style={{ width: "70px" }} title="*** NECESSARY  ** RECOMMENDED  * USEFUL">
            ***
          </th>
          <th style={{ width: "50px" }} title="WEAR PART (W) / SPARE PART (S)">
            W/S
          </th>
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
          const info = classifyComponent(l);
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
            <td className="num">{withUnit(l.installedQty, l.um)}</td>
            <td className="num">{withUnit(l.recommendedQty, l.um)}</td>
            <td className="num">{l.um || "NR"}</td>
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

export default function GestioneOfferte({ active = true }: { active?: boolean }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [docs, setDocs] = useState<DocumentoFile[]>([]);
  const [distinteAll, setDistinteAll] = useState<ArchivioDistinta[]>([]);
  const [listeAll, setListeAll] = useState<ArchivioDistinta[]>([]);
  const [orderPath, setOrderPath] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingDocs, setLoadingDocs] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

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
    setOrderPath((current) => (orders.some((order) => order.path === current) ? current : ""));
  }, []);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!active) return;
    reloadDocs()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingDocs(false));
  }, [active, reloadDocs]);

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
    () => docs.filter((d) => d.kind !== "ordine" && d.kind !== "distinta"),
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
  }, []);

  const generate = useCallback(async () => {
    if (!orderPath) {
      setError("Seleziona un ordine prima di generare l'offerta.");
      return;
    }
    setGenerating(true);
    setError(null);
    setOffer(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderPath, paths: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore");
      setOffer(data.offer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [orderPath, selected]);

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

        <div className="hint">
          Seleziona un ordine: leggo gli item dopo AFTER SALES e analizzo le distinte
          con quei codici. Con le spunte limiti l&apos;analisi alle distinte scelte.
        </div>
        <div className="doc-list">
          {loadingDocs && <div className="status">Caricamento…</div>}

          <div className="section-title">Ordini ({ordini.length})</div>
          {ordini.length === 0 && !loadingDocs && (
            <div className="hint">Nessun ordine riconosciuto.</div>
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
                <div className="sub">{formatSize(d.sizeBytes)}</div>
              </div>
              <span className="badge ordine">ordine</span>
            </div>
          ))}

          <div className="section-title">Distinte base ({distinte.length})</div>
          {!orderPath && !loadingDocs && (
            <div className="hint">Seleziona un ordine per vedere le distinte.</div>
          )}
          {orderPath && distinte.length === 0 && !loadingDocs && (
            <div className="hint">Nessuna distinta associata a questo ordine.</div>
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
                  {formatSize(d.sizeBytes)}
                </div>
              </div>
              <span className="badge distinta">distinta</span>
            </div>
          ))}

          {orderPath && (
            <>
              <div className="section-title">Motori e sensori ({liste.length})</div>
              {liste.length === 0 && !loadingDocs && (
                <div className="hint">Nessuna lista motori o sensori associata a questo ordine.</div>
              )}
              {liste.map((d) => (
                <div key={d.path} className="doc static">
                  <div className="meta">
                    <div className="name">{d.name}</div>
                    <div className="sub">{formatSize(d.sizeBytes)}</div>
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
                    <div className="sub">{formatSize(d.sizeBytes)}</div>
                  </div>
                  <span className={`badge ${d.kind}`}>{DOC_KIND_LABEL[d.kind]}</span>
                </div>
              ))}
            </>
          )}
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
              "Seleziona un ordine"
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
            Seleziona un ordine, poi premi <strong>Genera offerta</strong>:
            leggo quel documento, prendo gli item dopo <em>AFTER SALES</em> e
            uso le distinte associate.
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
