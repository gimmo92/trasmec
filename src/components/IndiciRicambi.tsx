"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const rowsRef = useRef<SpareIndexRow[]>([]);
  const deletedRef = useRef(new Set<string>());
  const saveTail = useRef(new Map<string, Promise<void>>());

  const replaceRows = (next: SpareIndexRow[]) => {
    rowsRef.current = next;
    setRows(next);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/indici");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore di caricamento");
      const items = (data.items ?? []) as SpareIndexRow[];
      rowsRef.current = items;
      deletedRef.current.clear();
      setRows(items);
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

  const editRow = (id: string, patch: Partial<SpareIndexRow>) => {
    if (deletedRef.current.has(id)) return;
    replaceRows(rowsRef.current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const writeLatest = async (id: string) => {
    if (deletedRef.current.has(id)) return;
    setSavingId(id);
    try {
      for (let guard = 0; guard < 20 && !deletedRef.current.has(id); guard += 1) {
        const snapshot = rowsRef.current.find((r) => r.id === id);
        if (!snapshot) return;
        const stamp = JSON.stringify(snapshot);
        const res = await fetch(`/api/indici/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(snapshot),
        });
        const data = await res.json().catch(() => ({}));
        if (deletedRef.current.has(id)) return;
        if (!res.ok) throw new Error(data.error || "Errore di salvataggio");
        const live = rowsRef.current.find((r) => r.id === id);
        if (!live || JSON.stringify(live) === stamp) {
          flash("Salvato");
          return;
        }
      }
    } catch (e) {
      if (!deletedRef.current.has(id)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSavingId((cur) => (cur === id ? null : cur));
    }
  };

  const saveRow = (id: string) => {
    if (deletedRef.current.has(id)) return;
    const prev = saveTail.current.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => writeLatest(id));
    saveTail.current.set(id, next);
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
      replaceRows([...rowsRef.current, data.item]);
      flash("Riga aggiunta");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeRow = async (row: SpareIndexRow) => {
    const label = row.indice || row.descrizioneOfferta || `#${row.n}`;
    if (!window.confirm(`Eliminare la riga «${label}»?`)) return;
    const previous = rowsRef.current;
    deletedRef.current.add(row.id);
    replaceRows(previous.filter((r) => r.id !== row.id));
    setError(null);
    try {
      const res = await fetch(`/api/indici/${row.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Errore di eliminazione");
      }
      flash("Riga eliminata");
    } catch (e) {
      deletedRef.current.delete(row.id);
      replaceRows(previous);
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
          <button type="button" className="primary" onClick={addRow}>
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
                      onChange={(e) => editRow(row.id, { n: Number(e.target.value) || 0 })}
                      onBlur={() => saveRow(row.id)}
                    />
                  </td>
                  <td>
                    <input
                      value={row.indice}
                      onChange={(e) => editRow(row.id, { indice: e.target.value })}
                      onBlur={() => saveRow(row.id)}
                    />
                  </td>
                  <td>
                    <input
                      value={row.descrizioneOfferta}
                      onChange={(e) => editRow(row.id, { descrizioneOfferta: e.target.value })}
                      onBlur={() => saveRow(row.id)}
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
                        editRow(row.id, { gestione: v });
                        saveRow(row.id);
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
                        editRow(row.id, { sparePartsList: v });
                        saveRow(row.id);
                      }}
                    >
                      <option value="SI">SI</option>
                      <option value="NO">NO</option>
                    </select>
                  </td>
                  <td>
                    <input
                      value={row.strutturaDescrizione ?? ""}
                      onChange={(e) => editRow(row.id, { strutturaDescrizione: e.target.value })}
                      onBlur={() => saveRow(row.id)}
                    />
                  </td>
                  <td>
                    <input
                      value={row.note}
                      onChange={(e) => editRow(row.id, { note: e.target.value })}
                      onBlur={() => saveRow(row.id)}
                    />
                  </td>
                  <td className="actions-col">
                    <button
                      type="button"
                      className="danger"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => removeRow(row)}
                    >
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
