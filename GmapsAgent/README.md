# GmapsAgent bundle



Self-contained copy of the Google Maps scraper Chrome extension and the Email Enricher tooling used to enrich exported leads.



## Chrome extension (load unpacked)



1. Open Chrome and go to `chrome://extensions`.

2. Enable **Developer mode**.

3. Click **Load unpacked** and select the folder:



   `GmapsAgent/extension`



   (Use the full path to `extension` inside this bundle on your machine.)



## Email Enricher (Python)



**First-time setup:** Run **`GmapsAgent/EmailEnricher/setup.bat`** once manually to create the virtual environment and install dependencies.



**Start the enrich API** (pick one):

- **(A) Automatic — Native Messaging:** one-time registration: run **`GmapsAgent/EmailEnricher/native_host/register_native_host.bat`**, paste the extension ID from `chrome://extensions`, choose the browser (use **All** if you use multiple Chromium installers — **All** registers Chrome/Brave/Chromium/Microsoft Edge under `HKCU\Software\...\NativeMessagingHosts\com.gmapsagent.enrich`). The generated manifest lists `allowed_origins` as **`chrome-extension://<id>/` with no wildcard** (required by Chromium). On Windows paths with spaces, run the BAT from explorer or `cmd`; it passes the folder safely to PowerShell (`%~dp0.` avoids a trailing-backslash quoting bug). Then fully quit the browser, reopen, and reload the extension. In the sidebar, use **Start enrich server (automatic)**. If something is wrong, run **`native_host/diagnose_native_host.bat`** — it prints registry `(default)`, whether the `.installed.json` manifest exists, parsed `name`/`path`, and whether the launcher exe exists for each browser hive.
- **(B) Manual:** double-click **`GmapsAgent/EmailEnricher/start_enrich_server.bat`** (visible CMD), same as always.

The sidebar uses **`GET {saved base URL}/health`** and **`POST …/v1/enrich`** (see **Remote enrich API** in the panel). Defaults to `http://127.0.0.1:18765` with no API key for local use. For a **VPS** deployment (Docker, API keys, Next admin UI), see **`GmapsAgent/deploy/vps/README.md`** and **`GmapsAgent/memory.txt`**.

Optional: open the extension **Options** page to save the enrich base URL / API key and your **`EmailEnricher`** folder path for **Copy path** buttons.



**Standalone enrichment:** From `GmapsAgent/EmailEnricher`, run **`run.bat`** for folder-in / folder-out CSV enrichment (same behavior as the original project).



## Repo layout note

The Chrome extension lives in **`GmapsAgent/extension/`** (recommended load path). The same files are also copied to the **repository root** so either folder works with **Load unpacked**. Always pick a folder that contains **`manifest.json`** directly — not the parent `GmapsAgent/` folder alone.

