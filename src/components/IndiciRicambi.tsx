"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpareIndexRow, SparePartsFlag } from "@/lib/types";

const GESTIONE_OPTIONS = [
  "Composto",
  "Composto + gruppo cuscinetti",
  "Unico",
  "Unico + gruppo cuscinetti",
  "Gestione separata",
];

type SortKey = keyof Pick<
  SpareIndexRow,
  | "n"
  | "indice"
  | "descrizioneOfferta"
  | "gestione"
  | "sparePartsList"
  | "strutturaDescrizione"
  | "note"
>;

export default function IndiciRicambi() {
  const [rows, setRows] = useState<SpareIndexRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("n");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/indici");
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

  const saveRow = async (id: string, patch: Partial<SpareIndexRow>) => {
    setSavingId(id);
    try {
      const res = await fetch(`/api/indici/${id}`, {
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
      const res = await fetch("/api/indici", {
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

  const removeRow = async (row: SpareIndexRow) => {
    const label = row.indice || row.descrizioneOfferta || `#${row.n}`;
    if (!window.confirm(`Eliminare la riga «${label}»?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/indici/${row.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore di eliminazione");
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      flash("Riga eliminata");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) =>
          [r.n, r.indice, r.descrizioneOfferta, r.gestione, r.sparePartsList, r.strutturaDescrizione, r.note]
            .join(" ")
            .toLowerCase()
            .includes(q)
        )
      : rows;
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), "it", { sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rows, query, sortKey, sortDir]);

  const th = (key: SortKey, label: string) => (
    <th onClick={() => toggleSort(key)}>
      <span>{label}</span>
      <span className={`sort ${sortKey === key ? "on" : ""}`}>
        {sortKey === key ? (sortDir === "asc" ? "▲" : "▼") : "▾"}
      </span>
    </th>
  );

  return (
    <div className="indici-page">
      <div className="indici-toolbar">
        <div>
          <h2>Indici dei ricambi</h2>
          <p className="indici-hint">
            Mapping indice → descrizione in offerta. Le modifiche si salvano
            automaticamente.
          </p>
        </div>
        <div className="actions">
          {status ? <span className="save-ok">{status}</span> : null}
          <input
            className="indici-search"
            placeholder="Filtra…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="primary" onClick={addRow}>
            Aggiungi riga
          </button>
        </div>
      </div>

      {error && <div className="warn">Errore: {error}</div>}

      <div className="indici-wrap">
        {loading ? (
          <div className="empty">Caricamento…</div>
        ) : (
          <table className="indici-table">
            <thead>
              <tr>
                {th("n", "N.")}
                {th("indice", "Indice (in descrizione o nel codice)")}
                {th("descrizioneOfferta", "Descrizione in offerta")}
                {th("gestione", "Gestione / Struttura")}
                {th("sparePartsList", "Spare Parts List")}
                {th("strutturaDescrizione", "Struttura descrizione")}
                {th("note", "Note")}
                <th className="actions-col">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty-cell">
                    Nessuna riga. Premi «Aggiungi riga» per crearne una.
                  </td>
                </tr>
              )}
              {visible.map((row) => (
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
                  <td>
                    <input
                      value={row.indice}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id ? { ...r, indice: e.target.value } : r
                          )
                        )
                      }
                      onBlur={(e) => saveRow(row.id, { indice: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      value={row.descrizioneOfferta}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id
                              ? { ...r, descrizioneOfferta: e.target.value }
                              : r
                          )
                        )
                      }
                      onBlur={(e) =>
                        saveRow(row.id, { descrizioneOfferta: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <select
                      value={
                        GESTIONE_OPTIONS.includes(row.gestione as (typeof GESTIONE_OPTIONS)[number])
                          ? row.gestione
                          : "__custom__"
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__custom__") return;
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id ? { ...r, gestione: v } : r
                          )
                        );
                        saveRow(row.id, { gestione: v });
                      }}
                    >
                      {GESTIONE_OPTIONS.map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                      {!GESTIONE_OPTIONS.includes(
                        row.gestione as (typeof GESTIONE_OPTIONS)[number]
                      ) && row.gestione ? (
                        <option value="__custom__">{row.gestione}</option>
                      ) : null}
                    </select>
                  </td>
                  <td>
                    <select
                      className={row.sparePartsList === "NO" ? "flag-no" : "flag-si"}
                      value={row.sparePartsList}
                      onChange={(e) => {
                        const v = e.target.value as SparePartsFlag;
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id ? { ...r, sparePartsList: v } : r
                          )
                        );
                        saveRow(row.id, { sparePartsList: v });
                      }}
                    >
                      <option value="SI">SI</option>
                      <option value="NO">NO</option>
                    </select>
                  </td>
                  <td>
                    <input
                      value={row.strutturaDescrizione ?? ""}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id
                              ? { ...r, strutturaDescrizione: e.target.value }
                              : r
                          )
                        )
                      }
                      onBlur={(e) =>
                        saveRow(row.id, { strutturaDescrizione: e.target.value })
                      }
                    />
                  </td>
                  <td>
                    <input
                      value={row.note}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r) =>
                            r.id === row.id ? { ...r, note: e.target.value } : r
                          )
                        )
                      }
                      onBlur={(e) => saveRow(row.id, { note: e.target.value })}
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
