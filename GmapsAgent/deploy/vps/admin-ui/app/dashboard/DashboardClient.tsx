"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type KeyRow = {
  id: number;
  label: string | null;
  created_at: string;
  revoked: boolean;
};

export default function DashboardClient() {
  const router = useRouter();
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr("");
    const r = await fetch("/api/keys", { cache: "no-store" });
    if (r.status === 401) {
      router.replace("/login");
      return;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(String(data.error || "Failed to load keys"));
      setLoading(false);
      return;
    }
    setKeys((data.keys as KeyRow[]) || []);
    setLoading(false);
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function createKey() {
    setErr("");
    setNewKey(null);
    const r = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: label.trim() || undefined }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      router.replace("/login");
      return;
    }
    if (!r.ok) {
      setErr(String(data.error || "Create failed"));
      return;
    }
    if (typeof data.api_key === "string") {
      setNewKey(data.api_key);
    }
    setLabel("");
    await load();
  }

  async function revoke(id: number) {
    if (!confirm(`Revoke key #${id}? The extension will stop working for this key.`)) return;
    setErr("");
    const r = await fetch(`/api/keys/${id}`, { method: "DELETE" });
    if (r.status === 401) {
      router.replace("/login");
      return;
    }
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      setErr(String(data.error || "Revoke failed"));
      return;
    }
    await load();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  if (loading) {
    return <p className="sub">Loading key list…</p>;
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: "1.25rem" }}>
        <button type="button" className="secondary" onClick={() => logout()}>
          Sign out
        </button>
      </div>

      <div className="card" style={{ marginBottom: "1.25rem" }}>
        <label htmlFor="lbl">Label (optional)</label>
        <input id="lbl" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. laptop" />
        <button type="button" onClick={() => createKey()}>
          Create key
        </button>
        {newKey ? (
          <div className="new-key">
            <strong>Copy now — shown once:</strong>
            <p className="mono">{newKey}</p>
          </div>
        ) : null}
        {err ? (
          <div className="msg err" role="alert">
            {err}
          </div>
        ) : null}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Label</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>
                  No keys yet.
                </td>
              </tr>
            ) : (
              keys.map((k) => (
                <tr key={k.id} className={k.revoked ? "revoked" : undefined}>
                  <td>{k.id}</td>
                  <td>{k.label || "—"}</td>
                  <td className="mono">{k.created_at}</td>
                  <td>
                    {!k.revoked ? (
                      <button type="button" className="danger" onClick={() => revoke(k.id)}>
                        Revoke
                      </button>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>Revoked</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
