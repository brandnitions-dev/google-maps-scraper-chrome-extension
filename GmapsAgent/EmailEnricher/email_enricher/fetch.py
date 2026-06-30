"""HTTP + optional Playwright HTML fetch."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@dataclass
class FetchResult:
    html: str
    status_code: int
    final_url: str


async def httpx_fetch(client: httpx.AsyncClient, url: str) -> FetchResult:
    try:
        r = await client.get(
            url,
            follow_redirects=True,
            headers={"User-Agent": DEFAULT_UA, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"},
        )
        return FetchResult(r.text or "", r.status_code, str(r.url))
    except httpx.HTTPError:
        return FetchResult("", 0, url)
    except Exception:
        return FetchResult("", 0, url)


class PlaywrightFetcher:
    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        if self._browser is not None:
            return
        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=True)
        self._context = await self._browser.new_context(user_agent=DEFAULT_UA)
        self._page = await self._context.new_page()

    async def close(self) -> None:
        try:
            if self._page:
                await self._page.close()
        finally:
            self._page = None
        try:
            if self._context:
                await self._context.close()
        finally:
            self._context = None
        try:
            if self._browser:
                await self._browser.close()
        finally:
            self._browser = None
        try:
            if self._playwright:
                await self._playwright.stop()
        finally:
            self._playwright = None

    async def fetch(self, url: str, timeout_ms: int = 28000) -> FetchResult:
        await self.start()
        assert self._page is not None
        async with self._lock:
            try:
                await self._page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                await asyncio.sleep(0.8)
                html = await self._page.content()
                u = self._page.url
                return FetchResult(html or "", 200, u)
            except Exception:
                return FetchResult("", 0, url)
