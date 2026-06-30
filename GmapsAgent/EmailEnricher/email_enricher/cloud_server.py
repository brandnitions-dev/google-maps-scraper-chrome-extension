"""VPS / Docker API: /v1/enrich (Bearer API key) + /admin/* (JWT)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import bcrypt
import httpx
import jwt
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from email_enricher import __version__
from email_enricher.enrich_worker import enrich_website
from email_enricher.fetch import PlaywrightFetcher
from email_enricher.key_store import (
    create_api_key_sync,
    init_schema_sync,
    list_api_keys_sync,
    revoke_api_key_sync,
    verify_api_key_sync,
)
from email_enricher.local_server import DEFAULT_ROW_DELAY_SEC, _sse_event

logger = logging.getLogger("email_enricher.cloud")

ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD_BCRYPT = os.environ.get("ADMIN_PASSWORD_BCRYPT", "").strip()
JWT_SECRET = os.environ.get("JWT_SECRET", "").strip()
SQLITE_PATH = os.environ.get("SQLITE_PATH", "/data/enricher.db")
JWT_ALG = "HS256"
JWT_EXPIRES_SEC = 24 * 3600


def _admin_jwt() -> str:
    if not JWT_SECRET or len(JWT_SECRET) < 16:
        raise RuntimeError("JWT_SECRET must be set (min 16 chars)")
    now = int(time.time())
    return jwt.encode(
        {"sub": ADMIN_USER, "typ": "admin", "iat": now, "exp": now + JWT_EXPIRES_SEC},
        JWT_SECRET,
        algorithm=JWT_ALG,
    )


def _decode_admin_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError:
        return None


def _bearer(request: Request) -> str | None:
    h = request.headers.get("authorization") or request.headers.get("Authorization")
    if not h:
        return None
    parts = h.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


async def _health(_request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "version": __version__, "mode": "cloud"})


async def _admin_login(request: Request) -> JSONResponse:
    if not ADMIN_PASSWORD_BCRYPT:
        return JSONResponse(
            {"error": "admin_not_configured", "hint": "Set ADMIN_PASSWORD_BCRYPT on server"},
            status_code=503,
        )
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_json"}, status_code=400)
    user = (body.get("username") or "").strip()
    pw = body.get("password") or ""
    if user != ADMIN_USER:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        ok = bcrypt.checkpw(
            pw.encode("utf-8"),
            ADMIN_PASSWORD_BCRYPT.encode("ascii"),
        )
    except Exception:
        ok = False
    if not ok:
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        token = _admin_jwt()
    except RuntimeError as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    return JSONResponse({"access_token": token, "token_type": "bearer", "expires_in": JWT_EXPIRES_SEC})


async def _admin_keys_list(request: Request) -> JSONResponse:
    tok = _bearer(request)
    if not tok:
        return JSONResponse({"error": "missing_token"}, status_code=401)
    data = _decode_admin_token(tok)
    if not data or data.get("typ") != "admin":
        return JSONResponse({"error": "invalid_token"}, status_code=401)
    keys = await run_in_threadpool(list_api_keys_sync, SQLITE_PATH)
    masked = []
    for k in keys:
        masked.append(
            {
                "id": k["id"],
                "label": k["label"],
                "created_at": k["created_at"],
                "revoked": bool(k["revoked"]),
            }
        )
    return JSONResponse({"keys": masked})


async def _admin_keys_create(request: Request) -> JSONResponse:
    tok = _bearer(request)
    if not tok:
        return JSONResponse({"error": "missing_token"}, status_code=401)
    data = _decode_admin_token(tok)
    if not data or data.get("typ") != "admin":
        return JSONResponse({"error": "invalid_token"}, status_code=401)
    try:
        body = await request.json()
    except Exception:
        body = {}
    label = body.get("label")
    kid, plain = await run_in_threadpool(create_api_key_sync, SQLITE_PATH, label)
    return JSONResponse(
        {
            "id": kid,
            "api_key": plain,
            "warning": "Copy now; the full key is never shown again.",
        }
    )


async def _admin_keys_delete(request: Request) -> JSONResponse:
    tok = _bearer(request)
    if not tok:
        return JSONResponse({"error": "missing_token"}, status_code=401)
    data = _decode_admin_token(tok)
    if not data or data.get("typ") != "admin":
        return JSONResponse({"error": "invalid_token"}, status_code=401)
    try:
        key_id = int(request.path_params["key_id"])
    except (KeyError, ValueError, TypeError):
        return JSONResponse({"error": "bad_id"}, status_code=400)
    did = await run_in_threadpool(revoke_api_key_sync, SQLITE_PATH, key_id)
    if not did:
        return JSONResponse({"error": "not_found"}, status_code=404)
    return JSONResponse({"ok": True})


async def _v1_enrich(request: Request) -> JSONResponse | StreamingResponse:
    api_key = _bearer(request)
    if not api_key:
        return JSONResponse({"error": "missing_api_key", "hint": "Authorization: Bearer <api_key>"}, status_code=401)
    valid = await run_in_threadpool(verify_api_key_sync, SQLITE_PATH, api_key)
    if not valid:
        return JSONResponse({"error": "invalid_api_key"}, status_code=401)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_json"}, status_code=400)

    rows = body.get("rows")
    if not isinstance(rows, list):
        return JSONResponse({"error": "rows must be a list"}, status_code=400)

    delay = body.get("delay", DEFAULT_ROW_DELAY_SEC)
    try:
        delay_f = float(delay)
    except (TypeError, ValueError):
        delay_f = DEFAULT_ROW_DELAY_SEC
    delay_f = max(0.0, delay_f)

    use_pw = not bool(body.get("no_playwright"))

    client: httpx.AsyncClient = request.app.state.http_client
    pw: PlaywrightFetcher | None = request.app.state.playwright_fetcher if use_pw else None

    async def event_stream() -> AsyncIterator[bytes]:
        for i, raw in enumerate(rows):
            if not isinstance(raw, dict):
                yield _sse_event(
                    "row",
                    {"index": i, "email": "", "error": "row is not an object"},
                )
                if delay_f > 0:
                    await asyncio.sleep(delay_f)
                continue
            wurl = (raw.get("website_url") or "").strip()
            try:
                email = await enrich_website(client, pw, use_pw, wurl)
            except Exception as e:
                logger.exception("enrich row %s", i)
                yield _sse_event("row", {"index": i, "email": "", "error": str(e)})
            else:
                yield _sse_event("row", {"index": i, "email": email or "", "error": None})
            if delay_f > 0 and i + 1 < len(rows):
                await asyncio.sleep(delay_f)
        yield _sse_event("done", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@asynccontextmanager
async def _lifespan(app: Starlette):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    os.makedirs(os.path.dirname(SQLITE_PATH) or ".", exist_ok=True)
    await run_in_threadpool(init_schema_sync, SQLITE_PATH)
    logger.info("cloud DB at %s", SQLITE_PATH)

    timeout = httpx.Timeout(22.0, connect=10.0)
    app.state.http_client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    app.state.playwright_fetcher = PlaywrightFetcher()
    try:
        yield
    finally:
        pw: PlaywrightFetcher = app.state.playwright_fetcher
        await pw.close()
        await app.state.http_client.aclose()


def build_cloud_app() -> Starlette:
    return Starlette(
        lifespan=_lifespan,
        routes=[
            Route("/health", _health, methods=["GET"]),
            Route("/v1/enrich", _v1_enrich, methods=["POST"]),
            Route("/admin/login", _admin_login, methods=["POST"]),
            Route("/admin/api-keys", _admin_keys_list, methods=["GET"]),
            Route("/admin/api-keys", _admin_keys_create, methods=["POST"]),
            Route("/admin/api-keys/{key_id}", _admin_keys_delete, methods=["DELETE"]),
        ],
    )


app = build_cloud_app()


def main() -> None:
    import uvicorn

    host = os.environ.get("API_HOST", "0.0.0.0")
    port = int(os.environ.get("API_PORT", "18765"))
    uvicorn.run(app, host=host, port=port, log_level="info", access_log=True)


if __name__ == "__main__":
    main()
