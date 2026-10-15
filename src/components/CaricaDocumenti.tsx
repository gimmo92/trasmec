"use client";

import { useRef, useState } from "react";
import { DOC_KIND_LABEL, type DocumentoFile } from "@/lib/types";

const DIRECT_LIMIT = 3_500_000;

async function putSigned(signedUrl: string, file: File): Promise<void> {
  const body = new FormData();
  body.append("cacheControl", "3600");
  body.append("file", file, file.name);
  const res = await fetch(signedUrl, { method: "PUT", body });
  if (!res.ok) throw new Error("Caricamento non riuscito");
}

async function uploadOne(file: File, cloud: boolean): Promise<DocumentoFile> {
  if (file.size > DIRECT_LIMIT && cloud) {
    const firma = await fetch("/api/documenti", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "firma", name: file.name, size: file.size }),
    });
    const meta = await firma.json().catch(() => ({}));
    if (!firma.ok) throw new Error(String(meta.error || "Caricamento non riuscito"));
    await putSigned(String(meta.signedUrl), file);
    const done = await fetch("/api/documenti", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "completa", name: meta.name }),
    });
    const saved = await done.json().catch(() => ({}));
    if (!done.ok) throw new Error(String(saved.error || "Classificazione non riuscita"));
    return saved.file as DocumentoFile;
  }

  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/documenti", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(data.error || "Caricamento non riuscito"));
  return data.file as DocumentoFile;
}

export default function CaricaDocumenti({
  cloud,
  onUploaded,
}: {
  cloud: boolean;
  onUploaded: () => Promise<void> | void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  async function send(list: File[]) {
    if (!list.length) return;
    setBusy(true);
    setError("");
    setNote("");
    const done: string[] = [];
    try {
      for (const file of list) {
        setNote(`Riconosco ${file.name}…`);
        const saved = await uploadOne(file, cloud);
        done.push(`${saved.name}: ${DOC_KIND_LABEL[saved.kind]}`);
      }
      setNote(done.join(" · "));
      await onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Caricamento non riuscito");
      if (done.length) await onUploaded();
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="upload-box">
      <button
        type="button"
        className={`dropzone ${over ? "over" : ""}`}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void send(Array.from(event.dataTransfer.files));
        }}
      >
        {busy ? "Classificazione…" : "Trascina qui i file, oppure sceglili"}
        <span>PDF ordine e Excel distinta. Li riconosco dal contenuto.</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.xlsx,.xlsm,.xls,application/pdf"
        multiple
        hidden
        onChange={(event) => void send(Array.from(event.target.files ?? []))}
      />
      {note && <div className="upload-note">{note}</div>}
      {error && <div className="login-error">{error}</div>}
    </div>
  );
}
