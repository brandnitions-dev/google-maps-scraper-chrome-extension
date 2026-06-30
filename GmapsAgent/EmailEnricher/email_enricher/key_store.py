"""SQLite API key storage (sync helpers; call from asyncio via run_in_threadpool)."""

from __future__ import annotations

import secrets
import sqlite3
import time
from typing import Any


def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def init_schema_sync(path: str) -> None:
    conn = _connect(path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS api_keys (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              key_hash TEXT NOT NULL,
              label TEXT,
              created_at TEXT NOT NULL,
              revoked INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys (revoked)")
    finally:
        conn.close()


def create_api_key_sync(path: str, label: str | None) -> tuple[int, str]:
    """Return (id, plaintext_key). Plaintext is shown once."""
    import bcrypt

    plain = "gms_" + secrets.token_urlsafe(32)
    h = bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("ascii")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    conn = _connect(path)
    try:
        cur = conn.execute(
            "INSERT INTO api_keys (key_hash, label, created_at, revoked) VALUES (?, ?, ?, 0)",
            (h, (label or "").strip() or None, now),
        )
        return int(cur.lastrowid), plain
    finally:
        conn.close()


def list_api_keys_sync(path: str) -> list[dict[str, Any]]:
    conn = _connect(path)
    try:
        rows = conn.execute(
            "SELECT id, label, created_at, revoked FROM api_keys ORDER BY id DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def revoke_api_key_sync(path: str, key_id: int) -> bool:
    conn = _connect(path)
    try:
        cur = conn.execute("UPDATE api_keys SET revoked = 1 WHERE id = ?", (key_id,))
        return cur.rowcount > 0
    finally:
        conn.close()


def verify_api_key_sync(path: str, plaintext: str) -> bool:
    """bcrypt-verify against active keys (small N)."""
    import bcrypt

    if not plaintext or not plaintext.strip():
        return False
    conn = _connect(path)
    try:
        rows = conn.execute(
            "SELECT key_hash FROM api_keys WHERE revoked = 0"
        ).fetchall()
    finally:
        conn.close()
    raw = plaintext.strip().encode("utf-8")
    for r in rows:
        try:
            if bcrypt.checkpw(raw, str(r["key_hash"]).encode("ascii")):
                return True
        except Exception:
            continue
    return False

