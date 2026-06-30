"""Extract and rank email candidates from HTML."""

from __future__ import annotations

import json
import re
import urllib.parse
from dataclasses import dataclass
from typing import Iterable

from bs4 import BeautifulSoup

EMAIL_RE = re.compile(
    r"\b[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?\b"
)

OBFUSCATED_AT = re.compile(
    r"\b([a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?)\s*(?:\[at\]|\(at\)|\s+at\s+)\s*([a-zA-Z0-9.-]+(?:\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*[a-zA-Z0-9.-]+)+)\b",
    re.I,
)

JUNK_LOCALPART = re.compile(
    r"^(noreply|no-reply|donotreply|do-notreply|privacy|abuse|postmaster|mailer-daemon|newsletter|bounce|unsubscribe)$",
    re.I,
)

DISPOSABLE_HINT = re.compile(r"example\.com|test\.com|domain\.com|yourdomain|email\.com|yoursite", re.I)


@dataclass
class Candidate:
    email: str
    score: int
    source: str


def normalize_host(host: str) -> str:
    h = (host or "").lower().strip()
    if h.startswith("www."):
        h = h[4:]
    return h


def email_domain(email: str) -> str:
    parts = email.rsplit("@", 1)
    if len(parts) != 2:
        return ""
    return normalize_host(parts[1])


def is_junk_email(email: str) -> bool:
    e = email.lower().strip()
    if not e or "@" not in e:
        return True
    local, _, domain = e.partition("@")
    if JUNK_LOCALPART.match(local.strip()):
        return True
    if DISPOSABLE_HINT.search(e):
        return True
    if local in ("admin", "root", "null", "undefined"):
        return True
    return False


def parse_mailto_href(href: str) -> list[str]:
    if not href or not href.lower().startswith("mailto:"):
        return []
    rest = href[7:]
    rest = urllib.parse.unquote(rest.split("?", 1)[0].split("#", 1)[0])
    parts = [p.strip() for p in re.split(r"[;,]", rest) if p.strip()]
    out = []
    for p in parts:
        if "@" in p and not p.startswith("//"):
            out.append(p.lower())
    return out


def soup_from_html(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


def strip_scripts_styles(soup: BeautifulSoup) -> None:
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()


def extract_mailto_from_soup(soup: BeautifulSoup, base_score: int, label: str) -> list[Candidate]:
    out: list[Candidate] = []
    for a in soup.select('a[href^="mailto:"]'):
        for e in parse_mailto_href(a.get("href") or ""):
            if e and not is_junk_email(e):
                out.append(Candidate(e, base_score, f"mailto:{label}"))
    return out


def extract_regex_from_text(text: str, base_score: int, label: str) -> list[Candidate]:
    out: list[Candidate] = []
    seen: set[str] = set()
    for m in EMAIL_RE.finditer(text or ""):
        e = m.group(0).lower()
        if e in seen:
            continue
        seen.add(e)
        if not is_junk_email(e):
            out.append(Candidate(e, base_score, f"regex:{label}"))
    return out


def deobfuscate_at_dot(text: str) -> list[str]:
    found = []
    for m in OBFUSCATED_AT.finditer(text or ""):
        local, dom = m.group(1), m.group(2)
        dom = re.sub(r"\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*", ".", dom, flags=re.I)
        dom = re.sub(r"\s+", "", dom)
        e = f"{local}@{dom}".lower()
        if "@" in e and not is_junk_email(e):
            found.append(e)
    return found


def scan_json_ld_and_next_data(html: str, base_score: int) -> list[Candidate]:
    out: list[Candidate] = []
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        re.I | re.S,
    ):
        chunk = m.group(1)
        try:
            data = json.loads(chunk)
        except json.JSONDecodeError:
            continue
        emails = _dig_json_for_emails(data)
        for e in emails:
            if not is_junk_email(e):
                out.append(Candidate(e.lower(), base_score + 5, "jsonld"))
    m2 = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.I | re.S)
    if m2:
        try:
            data = json.loads(m2.group(1))
            for e in _dig_json_for_emails(data):
                if not is_junk_email(e):
                    out.append(Candidate(e.lower(), base_score, "next_data"))
        except json.JSONDecodeError:
            pass
    return out


def _dig_json_for_emails(obj: object, acc: list[str] | None = None) -> list[str]:
    if acc is None:
        acc = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("email", "Email", "contactPoint") and isinstance(v, str) and "@" in v:
                acc.extend(EMAIL_RE.findall(v))
            _dig_json_for_emails(v, acc)
    elif isinstance(obj, list):
        for item in obj:
            _dig_json_for_emails(item, acc)
    elif isinstance(obj, str) and "@" in obj:
        acc.extend(EMAIL_RE.findall(obj))
    return acc


def looks_like_js_shell(html: str) -> bool:
    t = (html or "").lower()[:8000]
    if len(t) < 200:
        return True
    markers = ("you need to enable javascript", "enable javascript", "noscript", 'id="root"></div>')
    return sum(1 for m in markers if m in t) >= 2


def pick_best_email(candidates: Iterable[Candidate], site_host: str) -> str:
    site_host = normalize_host(site_host)
    scored: list[tuple[int, str]] = []
    for c in candidates:
        s = c.score
        dom = email_domain(c.email)
        if site_host and dom and (dom == site_host or dom.endswith("." + site_host) or site_host.endswith("." + dom)):
            s += 45
        if dom in ("gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"):
            s -= 15
        scored.append((s, c.email))
    if not scored:
        return ""
    scored.sort(key=lambda x: (-x[0], len(x[1])))
    return scored[0][1]


def dedupe_candidates(cands: list[Candidate]) -> list[Candidate]:
    by_email: dict[str, Candidate] = {}
    for c in cands:
        prev = by_email.get(c.email)
        if prev is None or c.score > prev.score:
            by_email[c.email] = c
    return list(by_email.values())


def collect_candidates(html: str, page_kind: str) -> list[Candidate]:
    if not html:
        return []
    mailto_score = 90 if page_kind == "contact" else 70
    regex_score = 40 if page_kind == "contact" else 25

    soup = soup_from_html(html)
    strip_scripts_styles(soup)
    candidates: list[Candidate] = []
    candidates.extend(extract_mailto_from_soup(soup, mailto_score, page_kind))

    text = soup.get_text(" ", strip=False)
    candidates.extend(extract_regex_from_text(text, regex_score, page_kind))
    for e in deobfuscate_at_dot(text):
        candidates.append(Candidate(e, regex_score - 5, f"deobf:{page_kind}"))

    candidates.extend(scan_json_ld_and_next_data(html, regex_score))
    return dedupe_candidates(candidates)


def merge_pick_email(buckets: list[list[Candidate]], site_host: str) -> str:
    flat: list[Candidate] = []
    for b in buckets:
        flat.extend(b)
    return pick_best_email(dedupe_candidates(flat), site_host)


def extract_from_html(html: str, page_kind: str, site_host: str) -> str:
    """page_kind: home | contact"""
    return merge_pick_email([collect_candidates(html, page_kind)], site_host)
