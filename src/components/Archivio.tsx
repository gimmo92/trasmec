"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import CaricaDocumenti from "@/components/CaricaDocumenti";
import { DOC_KIND_LABEL, type DocumentoFile } from "@/lib/types";

interface ArchivioDistinta extends DocumentoFile {
  ordini: string[];
  manual: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function orderTitle(order: DocumentoFile): string {
  return order.name;
}

function orderCodesLabel(order: DocumentoFile): string {
  const codes = order.codes ?? [];
  if (!codes.length) return order.code ?? "";
  const shown = codes.slice(0, 6).join(", ");
  return codes.length > 6 ? `${shown}… (${codes.length})` : shown;
}

export default function Archivio() {
  const [ordini, setOrdini] = useState<DocumentoFile[]>([]);
  const [distinte, setDistinte] = useState<ArchivioDistinta[]>([]);
  const [altri, setAltri] = useState<DocumentoFile[]>([]);
  const [cloud, setCloud] = useState(false);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const res = await fetch("/api/archivio");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data.error || "Errore archivio"));
    setOrdini(data.ordini ?? []);
    setDistinte(data.distinte ?? []);
    setAltri(data.altri ?? []);
    setCloud(Boolean(data.supabase));
  }, []);

  useEffect(() => {
    reload()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [reload]);

  const visibleOrders = useMemo(
    () => (filter ? ordini.filter((order) => order.name === filter) : ordini),
    [filter, ordini]
  );
  const loose = useMemo(
    () => (filter ? [] : distinte.filter((file) => file.ordini.length === 0)),
    [distinte, filter]
  );

  async function toggleOrder(file: ArchivioDistinta, orderName: string) {
    const has = file.ordini.includes(orderName);
    const next = has ? file.ordini.filter((name) => name !== orderName) : [...file.ordini, orderName];
    if (ordini.length > 0 && next.length === 0) {
      setError("Ogni distinta va associata ad almeno un ordine");
      return;
    }
    setError("");
    const previous = distinte;
    setDistinte((rows) =>
      rows.map((row) => (row.name === file.name ? { ...row, ordini: next, manual: true } : row))
    );
    const res = await fetch("/api/archivio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ distinta: file.name, ordini: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setDistinte(previous);
      setError(String(data.error || "Associazione non salvata"));
    }
  }

  function distinteDi(orderName: string): ArchivioDistinta[] {
    return distinte.filter((file) => file.ordini.includes(orderName));
  }

  return (
    <div className="archivio">
      <div className="archivio-head">
        <div>
          <h2>Archivio</h2>
          <p className="hint">
            Carica ordini e distinte. Ogni distinta resta collegata agli ordini che citano il suo
            codice, e puoi aggiungerne altri.
          </p>
        </div>
      </div>

      <CaricaDocumenti
        cloud={cloud}
        onUploaded={async () => {
          try {
            await reload();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />

      <div className="order-filters" role="group" aria-label="Filtra per ordine">
        <button type="button" className={filter ? "" : "on"} onClick={() => setFilter("")}>
          Tutti gli ordini
        </button>
        {ordini.map((order) => (
          <button
            key={order.name}
            type="button"
            className={filter === order.name ? "on" : ""}
            onClick={() => setFilter(order.name)}
          >
            {orderTitle(order)}
          </button>
        ))}
      </div>

      {error && <div className="login-error">{error}</div>}
      {loading && <div className="status">Caricamento…</div>}

      {!loading && ordini.length === 0 && (
        <p className="hint">Nessun ordine. Carica il PDF dell&apos;ordine per raggruppare le distinte.</p>
      )}

      {visibleOrders.map((order) => {
        const rows = distinteDi(order.name);
        return (
          <section key={order.name} className="order-group">
            <h3>{orderTitle(order)}</h3>
            {orderCodesLabel(order) && <p className="hint">{orderCodesLabel(order)}</p>}
            {rows.length === 0 && <p className="hint">Nessuna distinta associata a questo ordine.</p>}
            {rows.map((file) => (
              <DistintaCard
                key={`${order.name}:${file.name}`}
                file={file}
                ordini={ordini}
                onToggle={(orderName) => toggleOrder(file, orderName)}
              />
            ))}
          </section>
        );
      })}

      {loose.length > 0 && (
        <section className="order-group">
          <h3>Senza ordine</h3>
          <p className="hint">Associane almeno uno con le caselle qui sotto.</p>
          {loose.map((file) => (
            <DistintaCard
              key={file.name}
              file={file}
              ordini={ordini}
              onToggle={(orderName) => toggleOrder(file, orderName)}
            />
          ))}
        </section>
      )}

      {altri.length > 0 && !filter && (
        <section className="order-group">
          <h3>Altri documenti</h3>
          {altri.map((file) => (
            <div key={file.name} className="distinta-card static">
              <div>
                <div className="name">{file.name}</div>
                <div className="sub">{formatSize(file.sizeBytes)}</div>
              </div>
              <span className={`badge ${file.kind}`}>{DOC_KIND_LABEL[file.kind]}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function DistintaCard({
  file,
  ordini,
  onToggle,
}: {
  file: ArchivioDistinta;
  ordini: DocumentoFile[];
  onToggle: (orderName: string) => void;
}) {
  return (
    <article className="distinta-card">
      <div>
        <div className="name">{file.name}</div>
        <div className="sub">
          {file.code ? `${file.code} · ` : ""}
          {formatSize(file.sizeBytes)}
          {file.manual ? " · associazione manuale" : ""}
        </div>
        {ordini.length > 0 && (
          <div className="link-orders">
            {ordini.map((order) => (
              <label key={order.name}>
                <input
                  type="checkbox"
                  checked={file.ordini.includes(order.name)}
                  onChange={() => onToggle(order.name)}
                />
                {orderTitle(order)}
              </label>
            ))}
          </div>
        )}
      </div>
      <span className="badge distinta">distinta</span>
    </article>
  );
}
