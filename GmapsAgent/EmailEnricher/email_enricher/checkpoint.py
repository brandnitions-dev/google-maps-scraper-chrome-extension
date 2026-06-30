"""Resume progress + atomic CSV writes."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from email_enricher.csv_io import read_enriched_csv, write_enriched_csv_atomic

PROGRESS_SUFFIX = ".progress.json"


@dataclass
class ProgressState:
    source_path: str
    source_mtime: float
    source_size: int
    next_row_index: int
    output_name: str

    def fingerprint_ok(self, path: Path) -> bool:
        try:
            st = path.stat()
            return abs(st.st_mtime - self.source_mtime) < 0.01 and st.st_size == self.source_size
        except OSError:
            return False


def progress_path_for_output(output_csv: Path) -> Path:
    return output_csv.with_name(output_csv.stem + PROGRESS_SUFFIX)


def load_progress(output_csv: Path) -> ProgressState | None:
    p = progress_path_for_output(output_csv)
    if not p.is_file():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return ProgressState(
            source_path=str(raw["source_path"]),
            source_mtime=float(raw["source_mtime"]),
            source_size=int(raw["source_size"]),
            next_row_index=int(raw["next_row_index"]),
            output_name=str(raw["output_name"]),
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None


def save_progress(output_csv: Path, state: ProgressState) -> None:
    p = progress_path_for_output(output_csv)
    p.write_text(json.dumps(asdict(state), indent=2), encoding="utf-8")


def output_basename_for_input(input_csv: Path) -> str:
    stem = input_csv.stem
    if stem.lower().endswith("_enriched"):
        stem = stem[: -len("_enriched")]
    return f"{stem}_enriched.csv"


def validate_enriched_against_input(
    input_rows: list[dict[str, str]],
    enriched: list[dict[str, str]],
    through_index: int,
) -> bool:
    if len(enriched) != len(input_rows):
        return False
    for i in range(min(through_index, len(input_rows))):
        for h in ("search_query", "title", "address", "phone", "website_url"):
            if enriched[i].get(h, "") != input_rows[i].get(h, ""):
                return False
    return True


def atomic_write_enriched(output_csv: Path, rows: list[dict[str, str]]) -> None:
    write_enriched_csv_atomic(output_csv, rows)
