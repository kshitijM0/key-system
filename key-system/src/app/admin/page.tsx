"use client";

import { useEffect, useState } from "react";

type KeyRow = {
  id: string;
  key_value: string;
  duration_minutes: number;
  status: string;
  source: string;
  created_at: string;
  expires_at: string;
  last_reloaded_at: string | null;
};

const DURATION_PRESETS = [
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 60 * 24 },
  { label: "48 hours", minutes: 60 * 48 },
  { label: "7 days", minutes: 60 * 24 * 7 },
  { label: "30 days", minutes: 60 * 24 * 30 },
];

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [duration, setDuration] = useState(DURATION_PRESETS[1].minutes);
  const [busy, setBusy] = useState(false);

  async function loadKeys() {
    const res = await fetch("/api/admin/list-keys");
    if (res.ok) {
      const data = await res.json();
      setKeys(data.keys);
      setAuthed(true);
    }
  }

  useEffect(() => {
    loadKeys();
  }, []);

  async function login() {
    setLoginError("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      setAuthed(true);
      setPassword("");
      loadKeys();
    } else {
      const data = await res.json().catch(() => ({}));
      setLoginError(data.error ?? "Login failed.");
    }
  }

  async function generateKey() {
    setBusy(true);
    await fetch("/api/admin/generate-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationMinutes: duration }),
    });
    await loadKeys();
    setBusy(false);
  }

  async function reloadKey(id: string) {
    setBusy(true);
    await fetch("/api/admin/reload-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await loadKeys();
    setBusy(false);
  }

  async function revokeKey(id: string) {
    setBusy(true);
    await fetch("/api/admin/revoke-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await loadKeys();
    setBusy(false);
  }

  if (!authed) {
    return (
      <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 w-full max-w-sm space-y-4">
          <h1 className="text-lg font-semibold">Admin login</h1>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="Password"
            className="w-full rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
          {loginError && <p className="text-red-400 text-sm">{loginError}</p>}
          <button
            onClick={login}
            className="w-full rounded-lg bg-neutral-100 text-neutral-900 font-medium py-2 text-sm"
          >
            Log in
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 p-6 space-y-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-xl font-semibold">Key admin</h1>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <select
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm"
          >
            {DURATION_PRESETS.map((p) => (
              <option key={p.minutes} value={p.minutes}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            onClick={generateKey}
            disabled={busy}
            className="rounded-lg bg-emerald-500 text-neutral-950 font-medium px-4 py-2 text-sm disabled:opacity-50"
          >
            Generate key
          </button>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-800 text-neutral-400">
              <tr>
                <th className="text-left px-3 py-2">Key</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-left px-3 py-2">Expires</th>
                <th className="text-left px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-t border-neutral-800">
                  <td className="px-3 py-2 font-mono text-xs">{k.key_value}</td>
                  <td className="px-3 py-2">{k.status}</td>
                  <td className="px-3 py-2">{k.source}</td>
                  <td className="px-3 py-2 text-xs">
                    {new Date(k.expires_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 space-x-2">
                    <button
                      onClick={() => reloadKey(k.id)}
                      disabled={busy || k.status !== "active"}
                      className="text-emerald-400 hover:underline disabled:opacity-40"
                    >
                      Reload
                    </button>
                    <button
                      onClick={() => revokeKey(k.id)}
                      disabled={busy || k.status !== "active"}
                      className="text-red-400 hover:underline disabled:opacity-40"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
              {keys.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-neutral-500">
                    No keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
