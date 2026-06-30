"""
Chrome Native Messaging helper for EmailEnricher.

Protocol: stdin is a stream of Chrome messages: each message is a 4-byte unsigned
little-endian length (UTF-8 byte count) followed by UTF-8 JSON. Responses use the
same framing on stdout.

Chrome on Windows launches one host process per sendNativeMessage() call by default,
so this host reads a single JSON message from stdin, writes one framed JSON reply,
and exits. Responses must be flushed so Chrome does not hang.

start_server opens a visible CMD window running EmailEnricher\\start_enrich_server.bat
(via cmd.exe /c start ... /k) so the user sees the same console workflow as double-clicking
the batch file. If /health is already OK, no second window is started.
"""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HEALTH_URL = "http://127.0.0.1:18765/health"


def _native_host_dir() -> Path:
    return Path(__file__).resolve().parent


def _enricher_root() -> Path:
    return _native_host_dir().parent


def _venv_python() -> Path:
    return _enricher_root() / ".venv" / "Scripts" / "python.exe"


def _read_exact(stream, n: int) -> bytes | None:
    chunks: list[bytes] = []
    got = 0
    while got < n:
        b = stream.read(n - got)
        if not b:
            return None
        chunks.append(b)
        got += len(b)
    return b"".join(chunks)


def read_chrome_message() -> dict | None:
    ln = sys.stdin.buffer.read(4)
    if not ln:
        return None
    if len(ln) < 4:
        return None
    (length,) = struct.unpack("<I", ln)
    if length > 16 * 1024 * 1024:
        return None
    body = _read_exact(sys.stdin.buffer, length)
    if body is None:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:
        return None


def send_chrome_message(obj: dict) -> None:
    raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(raw)))
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def _health_check(timeout_sec: float = 2.0) -> tuple[bool, dict]:
    req = urllib.request.Request(HEALTH_URL, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            if resp.status != 200:
                return False, {}
            txt = resp.read().decode("utf-8", errors="replace")
            data = json.loads(txt)
            return bool(isinstance(data, dict) and data.get("ok") is True), data
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return False, {}


def _handle_ping(_msg: dict) -> dict:
    return {"ok": True}


def _handle_status(_msg: dict) -> dict:
    up, meta = _health_check()
    out: dict = {"ok": True, "server_up": up}
    if up and isinstance(meta, dict) and "version" in meta:
        out["version"] = meta.get("version")
    return out


def _handle_start_server(msg: dict) -> dict:
    enricher_root = _enricher_root()
    bat = enricher_root / "start_enrich_server.bat"
    py = _venv_python()
    if not bat.exists():
        return {
            "ok": False,
            "error": "missing_start_enrich_server_bat",
            "stderr_hint": f"Expected {bat}",
        }
    if not py.exists():
        return {
            "ok": False,
            "error": "missing_venv_python",
            "stderr_hint": f"Expected {py} — run setup.bat in EmailEnricher folder first.",
        }

    ok, meta = _health_check(timeout_sec=1.5)
    if ok:
        return {"ok": True, "started": False, "server_up": True, "already_running": True}

    root_s = str(enricher_root)
    cmd_k = f'cd /d "{root_s}" && start_enrich_server.bat'

    try:
        if sys.platform == "win32":
            subprocess.Popen(
                [
                    "cmd.exe",
                    "/c",
                    "start",
                    "Email enrich server",
                    "cmd.exe",
                    "/k",
                    cmd_k,
                ],
                cwd=root_s,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=False,
            )
        else:
            subprocess.Popen(
                [str(py), "-u", "-m", "email_enricher.local_server"],
                cwd=root_s,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=False,
            )
    except OSError as e:
        return {
            "ok": False,
            "error": str(e),
            "stderr_hint": "Could not open a console to run start_enrich_server.bat.",
        }

    try:
        delay = float(msg.get("post_start_delay_sec", 0.5))
    except (TypeError, ValueError):
        delay = 0.5
    time.sleep(max(0.0, delay))
    up, post = _health_check(timeout_sec=3.0)
    out: dict = {"ok": True, "started": True}
    out["confirmed"] = up
    out["server_up"] = up
    if post and isinstance(post, dict) and post.get("version") is not None:
        out["version"] = post.get("version")
    if not up:
        out["warning"] = "Process spawned but /health did not respond yet; check new console window for errors."
    return out


def dispatch(msg: dict) -> dict:
    if not isinstance(msg, dict):
        return {"ok": False, "error": "invalid_message"}
    cmd = msg.get("cmd")
    if cmd == "ping":
        return _handle_ping(msg)
    if cmd == "status":
        return _handle_status(msg)
    if cmd == "start_server":
        return _handle_start_server(msg)
    return {"ok": False, "error": f"unknown_cmd:{cmd!r}"}


def main() -> int:
    """Exit 0 after emitting a framed response so Chrome parses stdout; nonzero only on handshake failure."""

    msg = read_chrome_message()
    if msg is None:
        send_chrome_message({"ok": False, "error": "no_valid_message"})
        return 1
    try:
        reply = dispatch(msg)
        send_chrome_message(reply if isinstance(reply, dict) else {"ok": False, "error": "bad_dispatch"})
        return 0
    except Exception as e:
        try:
            send_chrome_message({"ok": False, "error": str(e)})
            return 0
        except Exception:
            pass
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
