# EmailEnricher

Enrich Google Maps lead CSVs (from the sibling Chrome extension) with an **`email`** column by fetching each `website_url` (HTTP-first, optional Playwright fallback).

## Input / output

- Put CSV files in **`data/`**. Expected columns: `search_query`, `title`, `address`, `phone`, `website_url` (same as extension export).
- Enriched files go to **`enriched_data/`**: `<original_stem>_enriched.csv` plus `<stem>_enriched.progress.json` for resume.

## Setup (Windows — recommended)

Double-click **`setup.bat`** in this folder. It will:

1. Use an existing Python 3.10+ if already installed, **or** try to install Python **3.12** via **winget** (needs Windows 10/11 with Microsoft Store / App Installer).
2. Create a **`.venv`** here and install all Python dependencies.
3. Run **`playwright install chromium`** for the headless browser fallback.

On a machine **without winget** or if the automatic Python install fails, install Python from [python.org](https://www.python.org/downloads/) (enable **Add python.exe to PATH**), then run **`setup.bat`** again.

## Setup (manual / macOS / Linux)

```bash
pip install -r requirements.txt
pip install -e .
playwright install chromium
```

## Local server (Chrome extension “Enrich emails”)

After **`setup.bat`**, start the API before using the sidebar enrich action: double-click **`start_enrich_server.bat`** (see **`GmapsAgent/README.md`**). Optional: save your **`EmailEnricher`** folder path in the extension **Options** page so the sidebar copy buttons use your full path.

- Listens on **`http://127.0.0.1:18765`**
- **`GET /health`** — `{ "ok": true, "version": "…" }`
- **`POST /enrich`** — JSON `{ "rows": [ { "search_query","title","address","phone","website_url" }, ... ] }`  
  Response: **`text/event-stream`** (SSE): `event: row` per row, then `event: done`.  
  Optional: `"delay": 0.75`, `"no_playwright": true`.

Uses the same enrichment logic as the CLI (`enrich_website` in `email_enricher/enrich_worker.py`).  
One shared **`httpx.AsyncClient`** and **`PlaywrightFetcher`** for the server process; install Chromium via **`setup.bat`**.

Keep **`run.bat`** for the standalone CSV batch workflow (read `data/`, write `enriched_data/`).

## Run (CLI — CSV files)

**Windows:** double-click **`run.bat`** (same as `python -m email_enricher` inside `.venv`).  
Optional arguments are passed through, e.g. `run.bat --force` or `run.bat --no-playwright`.

```bash
python -m email_enricher
# or:
python run.py
```

Options:

- `--data-dir PATH` / `--out-dir PATH` — override folders (defaults: `./data`, `./enriched_data`).
- `--no-playwright` — HTTP only (faster, misses some JS-heavy sites).
- `--limit N` — stop after **N** newly enriched rows this run (then resume later).
- `--force` — ignore progress and re-enrich from row 0 (overwrites output for that input).
- `--delay SEC` — pause between rows (default `0.75`).
- `--flush-every N` — write CSV + progress every **N** rows (default `1`; larger = fewer disk syncs, coarser resume).
- `--concurrency N` — process up to **N** input CSV files **in parallel** (default `1`; uses more RAM/CPU, no Rich bar).
- `--log-file PATH` — append debug log.

If the process stops, run again: it resumes when the source CSV is unchanged (mtime + size). With `--flush-every` > 1, only rows up to the last persisted checkpoint are guaranteed on disk.

## Legal

Use only for publicly posted contact data. Respect site terms, applicable law (e.g. GDPR/CCPA), and rate limits. This tool adds polite delays via sequential processing.
