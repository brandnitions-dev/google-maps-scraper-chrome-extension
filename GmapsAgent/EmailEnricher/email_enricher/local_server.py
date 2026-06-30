"""Local HTTP server for extension: SSE streaming email enrichment.

Uses one process-wide :class:`httpx.AsyncClient` and optional :class:`PlaywrightFetcher`
for the server lifetime (see Starlette lifespan). Install Chromium via ``setup.bat``
(``playwright install chromium``) for JS-heavy sites.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from email_enricher import __version__
from email_enricher.enrich_worker import enrich_website
from email_enricher.fetch import PlaywrightFetcher

logger = logging.getLogger("email_enricher.server")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18765
DEFAULT_ROW_DELAY_SEC = 0.75


def _sse_event(event: str, data_obj: Any) -> bytes:
    payload = json.dumps(data_obj, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n".encode("utf-8")


async def _health(_request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "version": __version__, "mode": "local"})


async def _enrich(request: Request) -> Response:
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

    timeout = httpx.Timeout(22.0, connect=10.0)
    app.state.http_client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    app.state.playwright_fetcher = PlaywrightFetcher()
    try:
        yield
    finally:
        pw: PlaywrightFetcher = app.state.playwright_fetcher
        await pw.close()
        await app.state.http_client.aclose()


def build_app() -> Starlette:
    return Starlette(
        lifespan=_lifespan,
        routes=[
            Route("/health", _health, methods=["GET"]),
            Route("/enrich", _enrich, methods=["POST"]),
            # Alias for extension "remote-style" path against local server (no API key).
            Route("/v1/enrich", _enrich, methods=["POST"]),
        ],
    )


def main() -> None:
    import uvicorn

    app = build_app()
    uvicorn.run(
        app,
        host=DEFAULT_HOST,
        port=DEFAULT_PORT,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
