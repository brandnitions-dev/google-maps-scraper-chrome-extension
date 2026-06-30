"""CLI: enrich Maps CSV exports with an email column."""

from __future__ import annotations

import argparse
import asyncio
import logging
from pathlib import Path

import httpx
from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

from email_enricher.checkpoint import (
    ProgressState,
    atomic_write_enriched,
    load_progress,
    output_basename_for_input,
    save_progress,
    validate_enriched_against_input,
)
from email_enricher.csv_io import read_enriched_csv, read_maps_csv
from email_enricher.enrich_worker import enrich_website
from email_enricher.fetch import PlaywrightFetcher

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
logger = logging.getLogger("email_enricher")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Enrich Maps CSV rows with emails from public websites.")
    p.add_argument(
        "--data-dir",
        type=Path,
        default=PACKAGE_ROOT / "data",
        help="Folder containing input CSV files (default: EmailEnricher/data)",
    )
    p.add_argument(
        "--out-dir",
        type=Path,
        default=PACKAGE_ROOT / "enriched_data",
        help="Folder for enriched CSV + progress files (default: EmailEnricher/enriched_data)",
    )
    p.add_argument(
        "--concurrency",
        type=int,
        default=1,
        metavar="N",
        help="Max CSV input files to process in parallel (default: 1). Each file still writes checkpoints row-by-row.",
    )
    p.add_argument(
        "--delay",
        type=float,
        default=0.75,
        metavar="SEC",
        help="Pause between rows (rate limiting; default: 0.75)",
    )
    p.add_argument(
        "--flush-every",
        type=int,
        default=1,
        metavar="N",
        help="Write CSV + progress every N completed rows (default: 1; use 5–20 for huge sheets)",
    )
    p.add_argument(
        "--no-playwright",
        action="store_true",
        help="HTTP-only (no headless browser fallback)",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        metavar="N",
        help="Stop after enriching N new rows this run (resume-friendly)",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Ignore saved progress and start from row 0",
    )
    p.add_argument(
        "--log-file",
        type=Path,
        default=None,
        help="Append detailed log to this file",
    )
    return p.parse_args()


def setup_logging(log_file: Path | None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logging.getLogger().addHandler(fh)


async def process_one_file(
    input_csv: Path,
    out_dir: Path,
    use_pw: bool,
    limit: int | None,
    force: bool,
    console: Console,
    delay_sec: float,
    flush_every: int,
    show_progress: bool,
) -> None:
    input_rows = read_maps_csv(input_csv)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_name = output_basename_for_input(input_csv)
    output_csv = out_dir / out_name
    mtime, size = input_csv.stat().st_mtime, input_csv.stat().st_size

    if force:
        console.print(f"[dim]Force: ignoring previous progress for {input_csv.name}[/dim]")

    rows: list[dict[str, str]]
    next_idx = 0
    prog_state = None if force else load_progress(output_csv)

    if not force and prog_state and prog_state.fingerprint_ok(input_csv):
        next_idx = prog_state.next_row_index
        existing = read_enriched_csv(output_csv)
        if existing and validate_enriched_against_input(input_rows, existing, next_idx):
            rows = existing
        else:
            console.print(f"[yellow]Progress/output mismatch; restarting {input_csv.name}[/yellow]")
            rows = [{**r, "email": ""} for r in input_rows]
            next_idx = 0
    else:
        rows = [{**r, "email": ""} for r in input_rows]
        next_idx = 0

    next_idx = min(max(0, next_idx), len(rows))
    remaining = len(rows) - next_idx
    if limit is not None:
        remaining = min(remaining, max(0, limit))
    if remaining == 0:
        console.print(f"[dim]Nothing to do for {input_csv.name} (already complete).[/dim]")
        return

    flush_every = max(1, flush_every)

    pw: PlaywrightFetcher | None = PlaywrightFetcher() if use_pw else None
    try:
        timeout = httpx.Timeout(22.0, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TextColumn("{task.completed}/{task.total}"),
                TimeElapsedColumn(),
                console=console,
                disable=not show_progress,
            ) as prog:
                task = prog.add_task(input_csv.name, total=max(1, remaining))
                processed_session = 0
                for i in range(next_idx, len(rows)):
                    wurl = rows[i].get("website_url", "")
                    desc = f"{input_csv.name} row {i + 1}/{len(rows)}"
                    prog.update(task, description=desc[:56])
                    try:
                        email = await enrich_website(client, pw, use_pw, wurl)
                    except Exception as e:
                        logger.exception("row %s failed", i)
                        email = ""
                        console.print(f"[red]Error row {i + 1}: {e}[/red]")
                    rows[i]["email"] = email
                    done_idx = i + 1
                    processed_session += 1
                    should_persist = (
                        (done_idx % flush_every == 0)
                        or done_idx >= len(rows)
                        or (limit is not None and processed_session >= limit)
                    )
                    if should_persist:
                        atomic_write_enriched(output_csv, rows)
                        st = ProgressState(
                            source_path=str(input_csv.resolve()),
                            source_mtime=mtime,
                            source_size=size,
                            next_row_index=done_idx,
                            output_name=out_name,
                        )
                        save_progress(output_csv, st)
                    prog.advance(task)
                    if not show_progress:
                        logger.info(
                            "%s row %s/%s email=%s",
                            input_csv.name,
                            done_idx,
                            len(rows),
                            (email[:48] + "...") if email and len(email) > 48 else email or "",
                        )
                    if limit is not None and processed_session >= limit:
                        break
                    if delay_sec > 0 and i + 1 < len(rows):
                        await asyncio.sleep(delay_sec)
    finally:
        if pw:
            await pw.close()

    console.print(f"[green]Wrote[/green] {output_csv}")


async def async_main() -> None:
    args = parse_args()
    setup_logging(args.log_file)
    data_dir = args.data_dir.resolve()
    out_dir = args.out_dir.resolve()
    console = Console()

    if not data_dir.is_dir():
        console.print(f"[red]Data directory not found:[/red] {data_dir}")
        raise SystemExit(2)

    csv_files = sorted(data_dir.glob("*.csv"))
    if not csv_files:
        console.print(f"[yellow]No CSV files in[/yellow] {data_dir}")
        raise SystemExit(1)

    use_pw = not args.no_playwright
    conc = max(1, args.concurrency)

    async def run_file(f: Path) -> None:
        if conc > 1:
            await process_one_file(
                f,
                out_dir,
                use_pw=use_pw,
                limit=args.limit,
                force=args.force,
                console=console,
                delay_sec=args.delay,
                flush_every=args.flush_every,
                show_progress=False,
            )
        else:
            await process_one_file(
                f,
                out_dir,
                use_pw=use_pw,
                limit=args.limit,
                force=args.force,
                console=console,
                delay_sec=args.delay,
                flush_every=args.flush_every,
                show_progress=True,
            )

    if conc <= 1:
        for f in csv_files:
            await run_file(f)
    else:
        console.print(
            f"[dim]Processing up to {conc} CSV files in parallel (no live bar; see logs).[/dim]"
        )
        sem = asyncio.Semaphore(conc)

        async def bounded(f: Path) -> None:
            async with sem:
                await run_file(f)

        await asyncio.gather(*(bounded(f) for f in csv_files))


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
