"""CSV read/write matching the Maps extension (background.js) rules."""

from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Any

EXPECTED_HEADERS = ["search_query", "title", "address", "phone", "website_url"]
OUTPUT_HEADERS = [*EXPECTED_HEADERS, "email"]


def escape_csv_cell(value: Any) -> str:
    s = "" if value is None else str(value)
    if any(c in s for c in '",\r\n'):
        return '"' + s.replace('"', '""') + '"'
    return s


def rows_to_csv(rows: list[dict[str, str]]) -> str:
    lines = [",".join(OUTPUT_HEADERS)]
    for row in rows:
        lines.append(
            ",".join(
                [
                    escape_csv_cell(row.get("search_query", "")),
                    escape_csv_cell(row.get("title", "")),
                    escape_csv_cell(row.get("address", "")),
                    escape_csv_cell(row.get("phone", "")),
                    escape_csv_cell(row.get("website_url", "")),
                    escape_csv_cell(row.get("email", "")),
                ]
            )
        )
    return "\ufeff" + "\r\n".join(lines)


def _strip_bom(text: str) -> str:
    if text.startswith("\ufeff"):
        return text[1:]
    return text


def read_maps_csv(path: Path) -> list[dict[str, str]]:
    raw = path.read_text(encoding="utf-8", errors="replace")
    raw = _strip_bom(raw)
    reader = csv.DictReader(io.StringIO(raw))
    if reader.fieldnames is None:
        raise ValueError(f"No headers in {path}")
    headers = [h.strip() for h in reader.fieldnames if h]
    if headers[: len(EXPECTED_HEADERS)] != EXPECTED_HEADERS:
        raise ValueError(
            f"Expected headers {EXPECTED_HEADERS}, got {headers[: len(EXPECTED_HEADERS)]!r} in {path}"
        )
    rows = []
    for r in reader:
        row = {k: (r.get(k) or "").strip() for k in EXPECTED_HEADERS}
        rows.append(row)
    return rows


def read_enriched_csv(path: Path) -> list[dict[str, str]] | None:
    if not path.is_file():
        return None
    raw = path.read_text(encoding="utf-8", errors="replace")
    raw = _strip_bom(raw)
    reader = csv.DictReader(io.StringIO(raw))
    if reader.fieldnames is None:
        return None
    headers = [h.strip() for h in reader.fieldnames if h]
    if headers != OUTPUT_HEADERS:
        return None
    rows = []
    for r in reader:
        rows.append({k: (r.get(k) or "").strip() for k in OUTPUT_HEADERS})
    return rows


def write_enriched_csv_atomic(path: Path, rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = rows_to_csv(rows)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8", newline="")
    tmp.replace(path)
