"""Shared async enrichment: resolve a public email from a business website URL."""

from __future__ import annotations

import asyncio
from urllib.parse import urlparse

import httpx

from email_enricher.crawl import discover_contact_urls
from email_enricher.extract import collect_candidates, looks_like_js_shell, merge_pick_email, normalize_host
from email_enricher.fetch import PlaywrightFetcher, httpx_fetch


def site_host_from_url(url: str) -> str:
    try:
        p = urlparse(url)
        return normalize_host(p.hostname or "")
    except Exception:
        return ""


def normalize_website_url(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if not s.lower().startswith(("http://", "https://")):
        s = "https://" + s
    return s


async def enrich_website(
    client: httpx.AsyncClient,
    pw: PlaywrightFetcher | None,
    use_pw: bool,
    website_url: str,
) -> str:
    url = normalize_website_url(website_url)
    if not url:
        return ""

    buckets: list = []
    fr = await httpx_fetch(client, url)
    base_final = fr.final_url or url
    host = site_host_from_url(base_final)

    if fr.status_code == 200 and fr.html:
        buckets.append(collect_candidates(fr.html, "home"))
        contact_urls = discover_contact_urls(fr.html, base_final, max_urls=3)
        if contact_urls:
            contact_results = await asyncio.gather(*[httpx_fetch(client, cu) for cu in contact_urls])
            for cr in contact_results:
                if cr.status_code == 200 and cr.html:
                    buckets.append(collect_candidates(cr.html, "contact"))

    best = merge_pick_email(buckets, host)

    need_pw = (
        use_pw
        and pw is not None
        and (
            not best
            or fr.status_code >= 400
            or not fr.html
            or (fr.html and looks_like_js_shell(fr.html))
        )
    )

    if need_pw and pw:
        pr = await pw.fetch(url)
        if pr.html:
            pw_final = pr.final_url or url
            pw_host = site_host_from_url(pw_final)
            buckets.append(collect_candidates(pr.html, "home"))
            cu_list = discover_contact_urls(pr.html, pw_final, max_urls=3)
            if cu_list:
                pw_results = await asyncio.gather(*[pw.fetch(cu) for cu in cu_list])
                for cr in pw_results:
                    if cr.html:
                        buckets.append(collect_candidates(cr.html, "contact"))
            best = merge_pick_email(buckets, pw_host or host)

    return best
