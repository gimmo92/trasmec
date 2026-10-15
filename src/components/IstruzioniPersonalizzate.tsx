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
      const res = await fetch("/api/istruzioni");
      const data = await res.json();
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
    window.setTimeout(() => setStatus(""), 1600);
  };

  const persist = useCallback(async (value: string) => {
    if (value === saved.current) return;
    const seq = ++saveSeq.current;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/istruzioni", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      const data = await res.json();
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
            Indicazioni extra per la generazione delle descrizioni in offerta.
            Si salvano da sole e valgono alla prossima generazione, insieme
            alle regole già impostate.
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
            : "Es. Per i cuscinetti usa sempre il nome commerciale completo. Non abbreviare i modelli. Preferisci descrizioni corte, una riga."
        }
        onChange={(e) => onChange(e.target.value)}
        aria-label="Istruzioni personalizzate"
      />
    </div>
  );
}
