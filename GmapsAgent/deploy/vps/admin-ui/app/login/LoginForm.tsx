"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof data.error === "string" ? data.error : "Login failed");
        setLoading(false);
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch {
      setError("Network error");
    }
    setLoading(false);
  }

  return (
    <div className="card">
      <form onSubmit={onSubmit}>
        <label htmlFor="user">Username</label>
        <input
          id="user"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="pw">Password</label>
        <input
          id="pw"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="row">
          <button type="submit" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </div>
        {error ? (
          <div className="msg err" role="alert">
            {error}
          </div>
        ) : null}
      </form>
    </div>
  );
}
