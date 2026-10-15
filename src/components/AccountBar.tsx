"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface PublicUser {
  email: string;
  createdAt: string;
}

export default function AccountBar() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/auth/session");
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!data.email) {
        router.replace("/login");
        return;
      }
      setEmail(String(data.email));
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function loadUsers() {
    const res = await fetch("/api/auth/utenti");
    const data = await res.json().catch(() => ({}));
    if (res.ok) setUsers(data.users ?? []);
  }

  async function toggleUsers() {
    const next = !open;
    setOpen(next);
    setError("");
    if (next) await loadUsers();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  async function addUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/utenti", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail, password: newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data.error || "Utente non creato"));
        return;
      }
      setNewEmail("");
      setNewPassword("");
      await loadUsers();
    } finally {
      setBusy(false);
    }
  }

  async function removeUser(target: string) {
    setError("");
    const res = await fetch("/api/auth/utenti", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: target }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(String(data.error || "Eliminazione non riuscita"));
      return;
    }
    await loadUsers();
  }

  return (
    <div className="nav-user">
      <span title={email}>{email}</span>
      <div className="user-pop">
        <button type="button" onClick={toggleUsers}>
          Utenti
        </button>
        {open && (
          <div className="user-panel">
            <ul className="user-list">
              {users.map((user) => (
                <li key={user.email}>
                  <span>{user.email}</span>
                  {user.email !== email && (
                    <button type="button" className="danger" onClick={() => removeUser(user.email)}>
                      Elimina
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <form onSubmit={addUser}>
              <label htmlFor="new-email">Nuovo utente</label>
              <input
                id="new-email"
                type="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                required
              />
              <label htmlFor="new-password">Password</label>
              <input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                minLength={8}
                required
              />
              {error && <div className="login-error">{error}</div>}
              <button className="primary" type="submit" disabled={busy}>
                Aggiungi
              </button>
            </form>
          </div>
        )}
      </div>
      <button type="button" onClick={logout}>
        Esci
      </button>
    </div>
  );
}
