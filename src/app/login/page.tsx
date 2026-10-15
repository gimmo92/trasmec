"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "loading" | "login" | "setup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/auth/session");
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (data.email) {
        router.replace("/");
        return;
      }
      setMode(data.needsSetup ? "setup" : "login");
      if (data.error) setError(String(data.error));
    })().catch(() => {
      if (!cancelled) {
        setMode("login");
        setError("Impossibile verificare la sessione");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (mode === "setup" && password !== confirm) {
      setError("Le password non coincidono");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(mode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data.error || "Accesso non riuscito"));
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Accesso non riuscito");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="logo">T</div>
        <h1>{mode === "setup" ? "Crea il primo account" : "Accedi"}</h1>
        <p className="hint">
          {mode === "setup"
            ? "Questo account apre l'app. Gli altri utenti si aggiungono dopo l'accesso."
            : "Offerte ricambi Trasmec"}
        </p>
        {mode === "loading" ? (
          <p className="hint">Verifica accesso…</p>
        ) : (
          <>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={8}
              required
            />
            {mode === "setup" && (
              <>
                <label htmlFor="confirm">Ripeti password</label>
                <input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  minLength={8}
                  required
                />
              </>
            )}
            {error && <div className="login-error">{error}</div>}
            <button className="primary" type="submit" disabled={busy}>
              {busy ? "Attendere…" : mode === "setup" ? "Crea account" : "Entra"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
