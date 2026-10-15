"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpareSiglaRow } from "@/lib/types";

export default function SigleSpareParts() {
  const [rows, setRows] = useState<SpareSiglaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sigle");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore di caricamento");
      setRows(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(""), 1600);
  };

  const saveRow = async (id: string, patch: Partial<SpareSiglaRow>) => {
    setSavingId(id);
    try {
      const res = await fetch(`/api/sigle/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore di salvataggio");
      setRows((prev) => prev.map((r) => (r.id === id ? data.item : r)));
      flash("Salvato");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingId(null);
    }
  };

  const addRow = async () => {
    setError(null);
    try {
      const res = await fetch("/api/sigle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore di creazione");
      setRows((prev) => [...prev, data.item]);
      flash("Riga aggiunta");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeRow = async (row: SpareSiglaRow) => {
    const label = row.sigla || `#${row.n}`;
    if (!window.confirm(`Eliminare la sigla «${label}»?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/sigle/${row.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore di eliminazione");
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      flash("Riga eliminata");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.n - b.n || a.sigla.localeCompare(b.sigla)),
    [rows]
  );

  return (
    <div className="indici-page">
      <div className="indici-toolbar">
        <div>
          <h2>Sigle parti di ricambio</h2>
          <p className="indici-hint">
            Filtro 1: in distinta restano solo i part number che iniziano con
            una di queste sigle. Le modifiche si salvano automaticamente e
            valgono alla prossima generazione.
          </p>
        </div>
        <div className="actions">
          {status ? <span className="save-ok">{status}</span> : null}
          <button className="primary" onClick={addRow}>
            Aggiungi sigla
          </button>
        </div>
      </div>

      {error && <div className="warn">Errore: {error}</div>}

      <div className="indici-wrap sigle-wrap">
        {loading ? (
          <div className="empty">Caricamento…</div>
        ) : (
          <table className="indici-table">
            <thead>
              <tr>
                <th>N.</th>
                <th>Sigla</th>
                <th className="actions-col">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty-cell">
                    Nessuna sigla. Premi «Aggiungi sigla» per crearne una.
                  </td>
                </tr>
              )}
              {sorted.map((row) => (
                <tr key={row.id} className={savingId === row.id ? "saving" : ""}>
                  <td className="n-col">
                    <input
                      type="number"
                      value={row.n}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id
                              ? { ...r, n: Number(e.target.value) || 0 }
                              : r
                          )
                        )
                      }
                      onBlur={(e) =>
                        saveRow(row.id, { n: Number(e.target.value) || 0 })
                      }
                    />
                  </td>
                  <td className="sigla-col">
                    <input
                      value={row.sigla}
                      maxLength={8}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id
                              ? { ...r, sigla: e.target.value.toUpperCase() }
                              : r
                          )
                        )
                      }
                      onBlur={(e) =>
                        saveRow(row.id, { sigla: e.target.value })
                      }
                    />
                  </td>
                  <td className="actions-col">
                    <button className="danger" onClick={() => removeRow(row)}>
                      Elimina
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
