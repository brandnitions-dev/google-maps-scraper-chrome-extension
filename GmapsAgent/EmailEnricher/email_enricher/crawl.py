"""Discover contact-page URLs from homepage HTML."""

from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

CONTACT_PATH_HINTS = re.compile(
    r"(contact|contacto|contactus|contact-us|kontakt|contatti|contato|"
    r"reach|get-in-touch|about|team|support|impressum|imprint|"
    r"geschaefts|datenschutz)",
    re.I,
)

CONTACT_TEXT_HINTS = re.compile(
    r"(^|\s)(contact|contact us|contacto|kontakt|contatti|contato|get in touch|reach us)(\s|$)",
    re.I,
)


def same_site(url: str, origin: str) -> bool:
    try:
        u = urlparse(url)
        o = urlparse(origin)
        if not u.netloc or not o.netloc:
            return False
        return normalize_netloc(u.netloc) == normalize_netloc(o.netloc)
    except Exception:
        return False


def normalize_netloc(netloc: str) -> str:
    n = netloc.lower()
    if n.startswith("www."):
        n = n[4:]
    return n


def discover_contact_urls(html: str, base_url: str, max_urls: int = 3) -> list[str]:
    if not html or not base_url:
        return []
    soup = BeautifulSoup(html, "html.parser")
    scored: list[tuple[int, str]] = []

    for a in soup.select('a[href^="http"], a[href^="/"], a[href^="./"]'):
        href = (a.get("href") or "").strip()
        if not href or href.startswith("#") or href.lower().startswith("javascript:"):
            continue
        abs_url = urljoin(base_url, href)
        if not same_site(abs_url, base_url):
            continue
        path = urlparse(abs_url).path or "/"
        text = (a.get_text() or "").strip()

        score = 0
        if CONTACT_PATH_HINTS.search(path):
            score += 50
        if CONTACT_TEXT_HINTS.search(text):
            score += 40
        if "/contact" in path.lower():
            score += 30
        if score > 0:
            scored.append((score, abs_url.split("#")[0]))

    scored.sort(key=lambda x: -x[0])
    seen: set[str] = set()
    out: list[str] = []
    for _, u in scored:
        if u not in seen:
            seen.add(u)
            out.append(u)
            if len(out) >= max_urls:
                break
    return out
