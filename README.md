# Google Maps Lead Scraper (Chrome extension)

Scrape Google Maps search results into CSV from a sidebar on [Google Maps](https://www.google.com/maps). Optional email enrichment via the bundled Python API.

## Quick install (Chrome)

1. Clone this repo:
   ```bash
   git clone https://github.com/brandnitions-dev/google-maps-scraper-chrome-extension.git
   cd google-maps-scraper-chrome-extension
   ```
2. Open **`chrome://extensions`**
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked**
5. Select **one** of these folders (both are valid after clone):
   - **`GmapsAgent/extension`** ← recommended
   - **repo root** (the folder that contains this `README.md` and `manifest.json`)

**Do not** select the `GmapsAgent` folder itself — it has no `manifest.json`.

6. Open **`https://www.google.com/maps`**
7. Click the extension toolbar icon to show the sidebar

### Scraping only (no Python)

Bulk keyword scraping and CSV export work **without** Email Enricher. Paste keywords or upload a `.txt` file, click **Start queue**, keep the Maps tab **focused**.

### Email enrich (optional)

See **`GmapsAgent/README.md`** for Python setup (`setup.bat`, local server, or VPS deploy).

## Troubleshooting

| Problem | Fix |
|--------|-----|
| Extension won't load | Load **`GmapsAgent/extension`** or repo root — not `GmapsAgent/` alone |
| Sidebar missing | Open Google Maps, click the extension icon in the toolbar |
| Batch / enrich buttons missing | Reload extension after pull; ensure `panel.html` matches latest (v1.0.11+) |
| Enrich fails | Scraping still works; run `GmapsAgent/EmailEnricher/setup.bat` or point panel at your VPS API |
| Errors in panel log | Enable **Verbose**, reproduce, copy last lines |

## Repo layout

| Path | Purpose |
|------|---------|
| `GmapsAgent/extension/` | Chrome extension (source of truth) |
| `GmapsAgent/EmailEnricher/` | Local / VPS email enrich API |
| `GmapsAgent/deploy/vps/` | Docker deploy for remote enrich |
| Root `*.js`, `manifest.json` | Mirror of extension for “load unpacked” from repo root |

More detail: **`GmapsAgent/README.md`**, **`GmapsAgent/memory.txt`**
