"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export default function IstruzioniPersonalizzate() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const saved = useRef("");
  const timer = useRef<number | null>(null);
  const saveSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/istruzioni", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Errore di caricamento");
      const value = typeof data.text === "string" ? data.text : "";
      saved.current = value;
      setText(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [load]);

  const flash = (msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(""), 2200);
  };

  const persist = useCallback(async (value: string) => {
    if (value === saved.current) {
      flash("Già salvato");
      return;
    }
    const seq = ++saveSeq.current;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/istruzioni", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (seq !== saveSeq.current) return;
      if (!res.ok) throw new Error(data.error || "Errore di salvataggio");
      saved.current = typeof data.text === "string" ? data.text : value;
      flash("Salvato");
    } catch (e) {
      if (seq !== saveSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === saveSeq.current) setSaving(false);
    }
  }, []);

  const onChange = (value: string) => {
    setText(value);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void persist(value);
    }, 700);
  };

  return (
    <div className="indici-page istruzioni-page">
      <div className="indici-toolbar">
        <div>
          <h2>Personalizza istruzioni</h2>
          <p className="indici-hint">
            Indicazioni extra per l&apos;Offerta lista impianto (non valgono per
            l&apos;Offerta richiesta cliente). Si salvano da sole (o con Salva) e
            valgono alla prossima generazione. Se scrivi di mettere fac simile in
            cima, compare in anteprima e in export. Le altre indicazioni le
            applica Claude a codici e descrizioni dei pezzi (es. «per il
            supporto C003369 usa il codice C003369-X»). Puoi anche togliere
            colonne dall&apos;export Excel (es. «esporta senza le colonne project e
            description»): vale subito, senza rigenerare. Le regole che richiedono
            di leggere un file vanno chieste come modifica all&apos;app.
          </p>
        </div>
        <div className="actions">
          {status ? <span className="save-ok">{status}</span> : null}
          {saving ? <span className="indici-hint">Salvataggio…</span> : null}
          <button
            className="primary"
            disabled={loading || saving}
            onClick={() => void persist(text)}
          >
            Salva
          </button>
        </div>
      </div>

      {error && <div className="warn">Errore: {error}</div>}

      <textarea
        className="istruzioni-input"
        value={text}
        disabled={loading}
        placeholder={
          loading
            ? "Caricamento…"
            : "Es. Scrivi FAC SIMILE in cima alle offerte. Per i cuscinetti usa il nome commerciale completo."
        }
        onChange={(e) => onChange(e.target.value)}
        aria-label="Istruzioni personalizzate"
      />
    </div>
  );
}
