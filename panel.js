const MAX_LINES = 600;

const DEFAULT_ENRICH_BASE = "http://127.0.0.1:18765";
const STORAGE_ENRICH_BASE = "enrichApiBaseUrl";
const STORAGE_ENRICH_KEY = "enrichApiKey";
const STORAGE_ENRICH_TARGET = "enrichApiTarget";
const STORAGE_AUTO_ENRICH = "autoEnrichEmails";
const STORAGE_COMBINE_BATCH = "combineBatchCsv";
const STORAGE_MAPS_REFRESH = "mapsRefreshEvery3";

/** Must match EmailEnricher `email_enricher.local_server.DEFAULT_PORT` (18765) when local. */
const NATIVE_MESSAGING_HOST = "com.gmapsagent.enrich";

const STORAGE_KEY_EMAIL_ENRICHER_DIR = "emailEnricherDir";

/** Per-Maps-tab queue key — content.js uses `gms_batch_v1_${tabId}` so parallel tabs do not steal each other. */
const BATCH_QUEUE_PREFIX = "gms_batch_v1_";

let mapsTabId = 0;

function batchQueueStorageKey() {
  return BATCH_QUEUE_PREFIX + String(mapsTabId || 0);
}

let batchScreenWakeLock = null;

async function acquireBatchWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    batchScreenWakeLock = await navigator.wakeLock.request("screen");
  } catch (_) {
    /* optional — user or browser may deny */
  }
}

async function releaseBatchWakeLock() {
  try {
    if (batchScreenWakeLock) await batchScreenWakeLock.release();
  } catch (_) {
    /* ignore */
  }
  batchScreenWakeLock = null;
}

function normalizeEnrichBase(s) {
  const t = String(s ?? "")
    .trim()
    .replace(/[/\\]+$/, "");
  return t || DEFAULT_ENRICH_BASE;
}

function inferEnrichTargetFromBase(base) {
  return enrichBaseLooksLocal(base) ? "local" : "remote";
}

function normalizeEnrichTarget(s, fallbackBase) {
  if (s === "local" || s === "remote") return s;
  return inferEnrichTargetFromBase(fallbackBase || DEFAULT_ENRICH_BASE);
}

function getPanelEnrichTarget() {
  const remoteBtn = $("enrichTargetRemoteBtn");
  if (remoteBtn?.classList.contains("active")) return "remote";
  const localBtn = $("enrichTargetLocalBtn");
  if (localBtn?.classList.contains("active")) return "local";
  return "";
}

function setPanelEnrichTarget(target) {
  const localBtn = $("enrichTargetLocalBtn");
  const remoteBtn = $("enrichTargetRemoteBtn");
  const hint = $("enrichTargetHint");
  const isLocal = target !== "remote";
  if (localBtn) localBtn.classList.toggle("active", isLocal);
  if (remoteBtn) remoteBtn.classList.toggle("active", !isLocal);
  if (hint) {
    hint.textContent = isLocal
      ? `Using local API at ${DEFAULT_ENRICH_BASE} (no key). Online URL stays saved.`
      : "Using the Online / VPS URL below. Switch to Local if that host is down.";
  }
}

function loadAutoEnrichToggle() {
  chrome.storage.sync.get([STORAGE_AUTO_ENRICH], (r) => {
    const el = $("autoEnrich");
    if (el) el.checked = !!r[STORAGE_AUTO_ENRICH];
  });
}

function persistAutoEnrichToggle() {
  const el = $("autoEnrich");
  if (!el) return;
  chrome.storage.sync.set({ [STORAGE_AUTO_ENRICH]: !!el.checked });
}

function loadCombineBatchToggle() {
  chrome.storage.sync.get([STORAGE_COMBINE_BATCH], (r) => {
    const el = $("combineBatchCsv");
    if (el) el.checked = !!r[STORAGE_COMBINE_BATCH];
  });
}

function persistCombineBatchToggle() {
  const el = $("combineBatchCsv");
  if (!el) return;
  chrome.storage.sync.set({ [STORAGE_COMBINE_BATCH]: !!el.checked });
}

function loadMapsRefreshToggle() {
  chrome.storage.sync.get([STORAGE_MAPS_REFRESH], (r) => {
    const el = $("mapsRefreshEvery3");
    if (el) el.checked = r[STORAGE_MAPS_REFRESH] !== false;
  });
}

function persistMapsRefreshToggle() {
  const el = $("mapsRefreshEvery3");
  if (!el) return;
  chrome.storage.sync.set({ [STORAGE_MAPS_REFRESH]: !!el.checked });
}

function updateCombineBatchVisibility() {
  const box = $("combineBatchBox");
  if (!box) return;
  const mode = $("mode")?.value;
  box.hidden = mode !== "paste" && mode !== "file";
}

function persistEnrichTarget(target) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [STORAGE_ENRICH_TARGET]: target === "remote" ? "remote" : "local" }, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

function loadEnrichSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_ENRICH_BASE, STORAGE_ENRICH_KEY, STORAGE_ENRICH_TARGET], (r) => {
      const base = normalizeEnrichBase(r[STORAGE_ENRICH_BASE]);
      resolve({
        base,
        apiKey: String(r[STORAGE_ENRICH_KEY] ?? "").trim(),
        target: normalizeEnrichTarget(r[STORAGE_ENRICH_TARGET], r[STORAGE_ENRICH_BASE] == null ? DEFAULT_ENRICH_BASE : base),
        neverSavedBase: r[STORAGE_ENRICH_BASE] === undefined || r[STORAGE_ENRICH_BASE] === null,
      });
    });
  });
}

/**
 * Local target always hits 127.0.0.1:18765 (no key). Remote uses the online URL/key fields
 * without overwriting them when you flip back to Local.
 */
async function getEffectiveEnrichBaseAndKey() {
  const saved = await loadEnrichSettings();
  const rawB = String($("enrichApiBaseUrl")?.value ?? "").trim();
  const rawK = String($("enrichApiKey")?.value ?? "").trim();
  const panelTarget = getPanelEnrichTarget();
  const target = panelTarget || saved.target;

  if (target === "local") {
    return {
      base: DEFAULT_ENRICH_BASE,
      apiKey: "",
      neverSavedBase: saved.neverSavedBase,
      usedSavedBecausePanelDefaultLocal: false,
      savedBase: saved.base,
      target,
    };
  }

  const base = rawB ? normalizeEnrichBase(rawB) : saved.base;
  const apiKey = rawK !== "" ? rawK : saved.apiKey;
  return {
    base,
    apiKey,
    neverSavedBase: saved.neverSavedBase,
    usedSavedBecausePanelDefaultLocal: false,
    savedBase: saved.base,
    target,
  };
}

async function ensureHostPermissionForUrl(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (origin === "http://127.0.0.1:18765" || origin === "http://localhost:18765") {
    return { ok: true, origin };
  }
  const perm = chrome.permissions;
  if (!perm) return { ok: true, origin };
  if (perm.contains) {
    const already = await new Promise((resolve) => {
      perm.contains({ origins: [`${origin}/*`] }, resolve);
    });
    if (already) return { ok: true, origin };
  }
  if (!perm.request) {
    return { ok: true, origin };
  }
  return new Promise((resolve) => {
    perm.request({ origins: [`${origin}/*`] }, (granted) => {
      const err = chrome.runtime.lastError;
      resolve({ ok: !!granted && !err, origin, err: err?.message });
    });
  });
}

function enrichBaseLooksLocal(base) {
  try {
    const u = new URL(String(base ?? "").trim());
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return true;
  }
}

function updateLocalEnrichServerPanelVisibility(targetOverride) {
  const block = $("localEnrichServerPanelBlock");
  const note = $("remoteEnrichServerNote");
  const apply = (target) => {
    const local = target !== "remote";
    if (block) block.hidden = !local;
    if (note) note.hidden = local;
    const startRow = $("startLocalServerRow");
    if (startRow) startRow.hidden = !local;
    setPanelEnrichTarget(local ? "local" : "remote");
  };
  if (targetOverride === "local" || targetOverride === "remote") {
    apply(targetOverride);
    return;
  }
  const panelTarget = getPanelEnrichTarget();
  if (panelTarget) {
    apply(panelTarget);
    return;
  }
  loadEnrichSettings().then(({ target }) => apply(target));
}

function applyEnrichRemoteInputsFromStorage() {
  return loadEnrichSettings().then(({ base, apiKey, target }) => {
    const u = $("enrichApiBaseUrl");
    const k = $("enrichApiKey");
    if (u && !enrichBaseLooksLocal(base)) u.value = base;
    else if (u && base && !u.value) u.value = enrichBaseLooksLocal(base) ? "" : base;
    if (k) k.value = apiKey;
    setPanelEnrichTarget(target);
    updateLocalEnrichServerPanelVisibility(target);
  });
}

async function readEnrichRemoteInputs() {
  const u = $("enrichApiBaseUrl");
  const k = $("enrichApiKey");
  const base = normalizeEnrichBase(u?.value);
  const apiKey = String(k?.value ?? "").trim();
  return { base, apiKey };
}

function currentExtensionOriginHintLine() {
  try {
    const id = chrome.runtime?.id ? String(chrome.runtime.id).trim() : "";
    return id ? `This extension origin is chrome-extension://${id}/ — register_native_host must write that EXACTLY (no "*" wildcard). Current ID from runtime: ${id}` : "";
  } catch {
    return "";
  }
}

function nativeHostSetupHint({ includeMismatchNote } = {}) {
  const bits = [];
  const idLine = currentExtensionOriginHintLine();
  if (includeMismatchNote && idLine) bits.push(idLine);
  const browserLine =
    "Browser prompt: Chrome = Google Chrome stable; All = registers Chrome channels + Chromium + Brave + Microsoft Edge HKCU hive (unpack the SAME extension folder there if needed).";
  bits.push(
    `Run EmailEnricher\\native_host\\register_native_host.bat — paste your extension ID from chrome://extensions (Developer mode — use today's ID if you re-loaded unpacked elsewhere). ${browserLine}`,
    "Fully quit browser windows; on Windows also end lingering chrome.exe / msedge.exe in Task Manager. Reopen Chrome, Reload the unpacked extension, then retry.",
    "Still broken? Run EmailEnricher\\native_host\\diagnose_native_host.bat — verify HKCU chrome stable default→com.gmapsagent.enrich.installed.json exists, UTF-8 JSON parses, launcher path resolves.",
  );
  return bits.join("\n");
}

function isNativeMessagingHostMissing(message) {
  const m = String(message || "").toLowerCase();
  if (!m) return false;
  if (m.includes("specified native messaging host not found")) return true;
  if (m.includes("native messaging host not found")) return true;
  if (m.includes("native messaging host") && m.includes("not found")) return true;
  return false;
}

function normalizeEmailEnricherDir(s) {
  return String(s ?? "")
    .trim()
    .replace(/[/\\]+$/, "");
}

function loadEmailEnricherDir() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEY_EMAIL_ENRICHER_DIR], (r) => {
      resolve(normalizeEmailEnricherDir(r[STORAGE_KEY_EMAIL_ENRICHER_DIR]));
    });
  });
}

function refreshSavedFolderUI(dir) {
  const el = document.getElementById("savedEnrichFolderLine");
  if (!el) return;
  if (dir) {
    el.textContent = `Saved folder: ${dir}`;
    return;
  }
  el.textContent = "Using default hint — set folder path in Options for Copy buttons.";
}

async function refreshSavedFolderFromStorage() {
  refreshSavedFolderUI(await loadEmailEnricherDir());
}

function unsetPathCopyReminder() {
  return [
    "Relative path: GmapsAgent\\EmailEnricher\\start_enrich_server.bat",
    "Open the extension Options page (Set folder path) and save your EmailEnricher folder so Copy buttons paste your full path.",
  ].join("\n");
}

async function copyPanelClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    appendLog({ level: "info", message: "Copied to clipboard.", ts: Date.now() });
  } catch {
    appendLog({ level: "warn", message: "Clipboard copy failed.", ts: Date.now() });
  }
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes[STORAGE_KEY_EMAIL_ENRICHER_DIR]) {
      const nv = changes[STORAGE_KEY_EMAIL_ENRICHER_DIR].newValue;
      refreshSavedFolderUI(normalizeEmailEnricherDir(nv));
    }
    if (changes[STORAGE_ENRICH_BASE] || changes[STORAGE_ENRICH_KEY] || changes[STORAGE_ENRICH_TARGET]) {
      applyEnrichRemoteInputsFromStorage();
    }
  });
}

function extFrameOrigin() {
  try {
    return new URL(chrome.runtime.getURL("/")).origin;
  } catch {
    return "";
  }
}

/** Fallback when INIT has not stored mapsPageOrigin yet. */
function parentPostOriginFromAncestors() {
  try {
    if (typeof location.ancestorOrigins !== "undefined" && location.ancestorOrigins?.length) {
      const o = String(location.ancestorOrigins[0]);
      const u = new URL(o);
      if (u.hostname.endsWith(".google.com") || u.hostname === "google.com") return u.origin;
    }
  } catch {}
  return "*";
}

function isTrustedMessengerOrigin(origin) {
  if (!origin) return false;
  if (origin === extFrameOrigin()) return true;
  try {
    const h = new URL(origin).hostname;
    return h.endsWith(".google.com") || h === "google.com";
  } catch {
    return false;
  }
}

function $(id) {
  return document.getElementById(id);
}

const enrichBaseUrlInput = $("enrichApiBaseUrl");
if (enrichBaseUrlInput) {
  enrichBaseUrlInput.addEventListener("input", () => updateLocalEnrichServerPanelVisibility());
}

async function selectEnrichTarget(target, { persist = true, log = true } = {}) {
  const next = target === "remote" ? "remote" : "local";
  setPanelEnrichTarget(next);
  updateLocalEnrichServerPanelVisibility(next);
  if (persist) await persistEnrichTarget(next);
  const useLocalBtn = $("useLocalInsteadBtn");
  if (useLocalBtn && next === "local") useLocalBtn.hidden = true;
  if (log) {
    appendLog({
      level: "info",
      message:
        next === "local"
          ? `Switched to local enrich API (${DEFAULT_ENRICH_BASE}). Online URL was not overwritten.`
          : "Switched to Online / VPS enrich API.",
      ts: Date.now(),
    });
  }
  await checkEnrichServerHealth();
}

const enrichTargetLocalBtn = $("enrichTargetLocalBtn");
if (enrichTargetLocalBtn) {
  enrichTargetLocalBtn.addEventListener("click", () => selectEnrichTarget("local"));
}
const enrichTargetRemoteBtn = $("enrichTargetRemoteBtn");
if (enrichTargetRemoteBtn) {
  enrichTargetRemoteBtn.addEventListener("click", () => selectEnrichTarget("remote"));
}

function parseLines(text) {
  let s = String(text || "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s
    .split(/\r\n|\n|\r|\u2028/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function postToParent(payload) {
  const fromInit = typeof window.__gmsMapsPageOrigin === "string" ? window.__gmsMapsPageOrigin.trim() : "";
  const fromAncestors = parentPostOriginFromAncestors();
  let tgt = fromAncestors;
  if (fromInit) {
    try {
      const h = new URL(fromInit).hostname;
      if (h.endsWith(".google.com") || h === "google.com") tgt = fromInit;
    } catch {}
  }
  try {
    window.parent.postMessage(payload, tgt === "*" ? "*" : tgt);
  } catch (_) {
    try {
      window.parent.postMessage(payload, "*");
    } catch (_) {}
  }
}

let lineCount = 0;
let enrichRunning = false;

function appendLog(entry) {
  const verbose = $("verbose").checked;
  const level = (entry.level || "info").toLowerCase();
  if (level === "debug" && !verbose) return;

  const view = $("logView");
  const ts = entry.ts || Date.now();
  const d = new Date(ts);
  const tsStr = d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");

  const row = document.createElement("div");
  row.className = "log-line";
  row.innerHTML = `
    <span class="log-ts">${escapeHtml(tsStr)}</span>
    <span class="log-lvl ${escapeAttr(level)}">${escapeHtml(level)}</span>
    <span class="log-msg">${escapeHtml(entry.message || "")}</span>
  `;
  view.appendChild(row);

  if (entry.detail != null && String(entry.detail).length) {
    const det = document.createElement("div");
    det.className = "log-detail";
    det.textContent = typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail, null, 2);
    view.appendChild(det);
  }

  lineCount += 1;
  while (view.childNodes.length > MAX_LINES * 2) {
    view.removeChild(view.firstChild);
    lineCount -= 1;
  }
  $("logCount").textContent = `${Math.max(lineCount, 0)} lines`;
  view.scrollTop = view.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return String(s).replace(/[^a-z0-9_-]/gi, "");
}

function readModeKeywords() {
  const mode = $("mode").value;
  if (mode === "single") {
    const q = $("keyword").value.trim();
    return q ? [q] : [];
  }
  if (mode === "paste") return parseLines($("batchPaste").value);
  return null;
}

async function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsText(file, "UTF-8");
  });
}

function setRunning(running) {
  $("startBtn").disabled = running;
  $("stopBtn").disabled = !running;
}

function showShell(show) {
  $("shell").classList.toggle("hidden", !show);
  $("rail").hidden = show;
}

$("btnMinimize").addEventListener("click", () => {
  showShell(false);
  postToParent({ type: "PANEL_STATE", minimized: true });
});

$("rail").addEventListener("click", () => {
  showShell(true);
  postToParent({ type: "PANEL_STATE", minimized: false });
});

$("mode").addEventListener("change", () => {
  const mode = $("mode").value;
  $("singleBox").hidden = mode !== "single";
  $("pasteBox").hidden = mode !== "paste";
  $("fileBox").hidden = mode !== "file";
  const hint = $("batchFileLineHint");
  if (hint && mode !== "file") hint.textContent = "";
  updateCombineBatchVisibility();
});

$("clearLog").addEventListener("click", () => {
  $("logView").innerHTML = "";
  lineCount = 0;
  $("logCount").textContent = "0 lines";
});

$("copyLog").addEventListener("click", async () => {
  const text = $("logView").innerText || "";
  try {
    await navigator.clipboard.writeText(text);
    appendLog({ level: "info", message: "Log copied to clipboard.", ts: Date.now() });
  } catch {
    appendLog({ level: "warn", message: "Clipboard copy failed.", ts: Date.now() });
  }
});

$("verbose").addEventListener("change", () => {
  postToParent({ type: "VERBOSE", value: $("verbose").checked });
});

$("stopBtn").addEventListener("click", () => {
  releaseBatchWakeLock().catch(() => {});
  postToParent({ type: "STOP" });
  appendLog({ level: "warn", message: "Stop requested — finishes current listing then halts.", ts: Date.now() });
});

function resetLeadsTable() {
  $("leadsBody").innerHTML = "";
  $("leadsCount").textContent = "0 rows";
}

function setEnrichRunning(running) {
  enrichRunning = !!running;
  const btn = $("enrichEmailsBtn");
  if (btn) btn.disabled = enrichRunning;
}

function enrichFetchFailedHint(base) {
  const b = String(base || "");
  const local = b.includes("127.0.0.1") || b.includes("localhost");
  const lines = [
    local
      ? "Nothing answered at this URL — for a LOCAL API: run EmailEnricher\\start_enrich_server.bat (or Native Messaging “Start enrich server”). For a VPS: set the first field to http://YOUR_SERVER:31876 (not 127.0.0.1), click Save enrich remote, then Test — if the log line above still shows 127.0.0.1, the panel default overwrote your VPS URL; re-paste :31876 and Save."
      : "Nothing answered — check the API URL, VPS firewall (TCP 31876 for API, 31877 for admin), and that docker compose is up.",
    !local
      ? "Chrome: this extension must have host permission for your API (click “Save enrich remote” and allow, or Test will get Failed to fetch from the service worker)."
      : null,
    `Verify in a normal tab: open ${b}/health`,
    "Health checks use the extension background worker first (more reliable while Maps is open).",
  ].filter(Boolean);
  return lines.join("\n");
}

function enricherHealthViaBackground(baseUrl) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: "ENRICHER_HEALTH", baseUrl }, (res) => {
        const le = chrome.runtime.lastError;
        resolve(
          le
            ? { ok: false, fetchError: le.message, via: "background" }
            : res && typeof res === "object"
              ? { ...res, via: "background" }
              : { ok: false, via: "background" }
        );
      });
    } catch (e) {
      resolve({ ok: false, fetchError: String(e?.message || e), via: "background" });
    }
  });
}

function enricherProbeEnrichViaBackground(baseUrl, apiKey) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { action: "ENRICHER_PROBE_ENRICH", baseUrl, apiKey: apiKey || "" },
        (res) => {
          const le = chrome.runtime.lastError;
          resolve(
            le
              ? { ok: false, fetchError: le.message, via: "background" }
              : res && typeof res === "object"
                ? { ...res, via: "background" }
                : { ok: false, via: "background" }
          );
        }
      );
    } catch (e) {
      resolve({ ok: false, fetchError: String(e?.message || e), via: "background" });
    }
  });
}

async function checkEnrichServerHealth() {
  const el = $("enrichServerStatus");
  if (!el) return false;
  const useLocalBtn = $("useLocalInsteadBtn");
  el.className = "server-status checking";
  el.textContent = "Server: checking…";
  const { base, target } = await getEffectiveEnrichBaseAndKey();
  const label = target === "remote" ? "online" : "local";

  const perm = await ensureHostPermissionForUrl(base);
  if (!perm.ok) {
    el.textContent = "Server: blocked — allow Chrome access to your API URL (Save connection / prompt).";
    el.className = "server-status down";
    if (useLocalBtn) useLocalBtn.hidden = target !== "remote";
    return false;
  }

  async function applyOk(j) {
    const v = j.version != null ? String(j.version) : "?";
    const mode = j.mode === "cloud" ? "cloud" : "local";
    el.textContent = `Server: up (v${v}, ${mode}) @ ${base} · ${label}`;
    el.className = "server-status ok";
    if (useLocalBtn) useLocalBtn.hidden = true;
    return true;
  }

  /** Prefer service worker fetch (works when Maps-embedded iframe blocks direct localhost). */
  const bg = await enricherHealthViaBackground(base);
  if (bg.ok && bg.json && bg.json.ok === true) {
    return applyOk(bg.json);
  }

  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
    const r = await fetch(`${base}/health`, {
      method: "GET",
      signal: ctrl ? ctrl.signal : undefined,
      cache: "no-store",
    });
    if (t) clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j && j.ok === true) {
      return applyOk(j);
    }
  } catch (_) {
    /* panel fetch failed */
  }

  el.textContent =
    target === "remote"
      ? `Server: down — ${base} (online). Switch to Local if the VPS is off.`
      : `Server: down — ${base} (local). Start EmailEnricher\\start_enrich_server.bat.`;
  el.className = "server-status down";
  if (useLocalBtn) useLocalBtn.hidden = target !== "remote";
  return false;
}

async function runEnrichStream(rows) {
  setEnrichRunning(true);
  let sawDone = false;
  try {
    const { base, apiKey } = await getEffectiveEnrichBaseAndKey();
    const perm = await ensureHostPermissionForUrl(base);
    if (!perm.ok) {
      let host = perm.origin;
      if (!host) {
        try {
          host = new URL(base).origin;
        } catch {
          host = "this API host";
        }
      }
      appendLog({
        level: "error",
        message: "Chrome blocked access to the enrich API URL.",
        detail: `Allow this extension to access ${host}. Use “Save enrich remote” or approve the permission prompt. ${perm.err || perm.reason || ""}`,
        ts: Date.now(),
      });
      return false;
    }
    appendLog({
      level: "info",
      message: "Enrich: streaming /v1/enrich via background worker (Maps iframe cannot call this URL reliably).",
      ts: Date.now(),
    });

    await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let port;
    try {
      port = chrome.runtime.connect({ name: "ENRICH_STREAM" });
    } catch (e) {
      appendLog({
        level: "error",
        message: `Enrich failed: ${e?.message || e}`,
        detail: enrichFetchFailedHint(base),
        ts: Date.now(),
      });
      finish();
      return;
    }

    const onMsg = (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ROW" && typeof msg.index === "number") {
        const src = rows[msg.index];
        const sessionIndex =
          src && typeof src.sessionIndex === "number" && src.sessionIndex >= 0 ? src.sessionIndex : msg.index;
        postToParent({ type: "ENRICH_ROW", index: sessionIndex, email: msg.email != null ? String(msg.email) : "" });
        if (msg.error) {
          appendLog({
            level: "warn",
            message: `Row ${msg.index + 1}: ${msg.error}`,
            ts: Date.now(),
          });
        }
        return;
      }
      if (msg.type === "PROBLEM") {
        if (msg.kind === "http") {
          appendLog({
            level: "error",
            message: `Enrich HTTP ${msg.status ?? "?"}`,
            detail: String(msg.text || "").slice(0, 400),
            ts: Date.now(),
          });
        } else {
          appendLog({
            level: "error",
            message: `Enrich failed: ${msg.message || msg.kind || "error"}`,
            detail: msg.kind === "fetch" ? enrichFetchFailedHint(base) : "",
            ts: Date.now(),
          });
        }
        return;
      }
      if (msg.type === "END") {
        sawDone = !!msg.sawDone;
        port.onMessage.removeListener(onMsg);
        try {
          port.disconnect();
        } catch (_) {}
        if (!sawDone) {
          appendLog({
            level: "warn",
            message:
              "Enrich stream ended before “done” — server may have stopped. Rows already received stay in the table.",
            ts: Date.now(),
          });
        } else {
          appendLog({ level: "info", message: "Email enrich finished.", ts: Date.now() });
        }
        finish();
      }
    };

    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(() => {
      if (!settled) {
        appendLog({
          level: "warn",
          message: "Enrich connection to background closed early — partial rows may remain.",
          ts: Date.now(),
        });
        finish();
      }
    });

    try {
      port.postMessage({ type: "START", baseUrl: base, apiKey, rows });
    } catch (e) {
      appendLog({
        level: "error",
        message: `Enrich failed: ${e?.message || e}`,
        detail: enrichFetchFailedHint(base),
        ts: Date.now(),
      });
      try {
        port.disconnect();
      } catch (_) {}
      finish();
    }
    });
    return sawDone;
  } finally {
    setEnrichRunning(false);
    checkEnrichServerHealth();
  }
}

function appendLeadRow(row, sessionIndex) {
  const tbody = $("leadsBody");
  const tr = document.createElement("tr");
  tr.dataset.sidx = String(sessionIndex);
  const displayNum = sessionIndex + 1;
  const cols = [
    String(displayNum),
    row.search_query || "",
    row.title || "",
    row.phone || "",
    row.website_url || "",
    row.email || "",
  ];
  cols.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (i >= 2) td.title = text;
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}

function updateLeadRowBySessionIndex(sessionIndex, row) {
  const tbody = $("leadsBody");
  const tr = tbody.querySelector(`tr[data-sidx="${sessionIndex}"]`);
  if (!tr) {
    appendLeadRow(row, sessionIndex);
    return;
  }
  const displayNum = sessionIndex + 1;
  const cols = [
    String(displayNum),
    row.search_query || "",
    row.title || "",
    row.phone || "",
    row.website_url || "",
    row.email || "",
  ];
  cols.forEach((text, i) => {
    const cell = tr.cells[i];
    if (cell) {
      cell.textContent = text;
      if (i >= 2) cell.title = text;
    }
  });
}

$("exportSessionBtn").addEventListener("click", () => {
  appendLog({
    level: "info",
    message: "Export session CSV — sending to tab…",
    ts: Date.now(),
  });
  postToParent({ type: "EXPORT_SESSION_CSV", filename: "maps_session_leads" });
});

$("clearSessionBtn").addEventListener("click", () => {
  postToParent({ type: "CLEAR_SESSION_LEADS" });
});

$("enrichEmailsBtn").addEventListener("click", async () => {
  if (enrichRunning) return;
  const ok = await checkEnrichServerHealth();
  if (!ok) {
    appendLog({
      level: "error",
      message: "Email enrich server unreachable.",
      detail: `Check saved API base URL and /health — local: start_enrich_server.bat; VPS: GmapsAgent/deploy/vps.`,
      ts: Date.now(),
    });
    return;
  }
  appendLog({ level: "info", message: "Requesting rows from Maps tab for enrich…", ts: Date.now() });
  postToParent({ type: "ENRICH_REQUEST" });
});

const openEnrichOptionsBtn = $("openEnrichOptionsBtn");
if (openEnrichOptionsBtn) {
  openEnrichOptionsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

const copyBatPathBtn = $("copyBatPathBtn");
if (copyBatPathBtn) {
  copyBatPathBtn.addEventListener("click", async () => {
    const dir = await loadEmailEnricherDir();
    const text = dir ? `${dir}\\start_enrich_server.bat` : unsetPathCopyReminder();
    await copyPanelClipboard(text);
  });
}

const copyFolderPathBtn = $("copyFolderPathBtn");
if (copyFolderPathBtn) {
  copyFolderPathBtn.addEventListener("click", async () => {
    const dir = await loadEmailEnricherDir();
    const text = dir || unsetPathCopyReminder();
    await copyPanelClipboard(text);
  });
}

const testEnrichRemoteBtn = $("testEnrichRemoteBtn");
if (testEnrichRemoteBtn) {
  testEnrichRemoteBtn.addEventListener("click", async () => {
    const eff = await getEffectiveEnrichBaseAndKey();
    const { base, apiKey, neverSavedBase, target } = eff;

    if (target === "remote" && neverSavedBase && !String($("enrichApiBaseUrl")?.value ?? "").trim()) {
      appendLog({
        level: "error",
        message: "No online enrich API URL saved yet.",
        detail:
          "Paste http://YOUR_VPS_IP:31876, click Save connection, allow host access when Chrome asks, then Test again. Or switch to Local if the VPS is off.",
        ts: Date.now(),
      });
      return;
    }

    if (target === "local") {
      appendLog({
        level: "info",
        message: `Testing local enrich API at ${DEFAULT_ENRICH_BASE}`,
        ts: Date.now(),
      });
    } else {
      const saved = await loadEnrichSettings();
      const rawB = String($("enrichApiBaseUrl")?.value ?? "").trim();
      if (!rawB) {
        appendLog({
          level: "info",
          message: `API base field is empty — using last-saved base: ${base}`,
          ts: Date.now(),
        });
      } else if (saved.base !== base || saved.apiKey !== apiKey) {
        appendLog({
          level: "warn",
          message:
            "Panel differs from last Save — this Test uses the Online URL as typed. Click Save connection so values match.",
          detail: `Saved base: ${saved.base}\nEffective base: ${base}`,
          ts: Date.now(),
        });
      }
    }

    const perm = await ensureHostPermissionForUrl(base);
    if (!perm.ok) {
      const hint = perm.reason === "bad_url" ? "Invalid API base URL." : `Allow access to ${perm.origin || "this host"}`;
      appendLog({
        level: "error",
        message: "Chrome blocked the enrich API (host permission or bad URL).",
        detail: `${hint}. Click “Save enrich remote” or approve the prompt. ${perm.err || ""}`,
        ts: Date.now(),
      });
      return;
    }

    appendLog({ level: "info", message: `Test: /health + /v1/enrich @ ${base} (via background worker)`, ts: Date.now() });
    const hbg = await enricherHealthViaBackground(base);
    if (hbg.ok && hbg.json && hbg.json.ok === true) {
      appendLog({
        level: "info",
        message: `/health OK (v${hbg.json.version != null ? hbg.json.version : "?"})`,
        ts: Date.now(),
      });
    } else {
      appendLog({
        level: "error",
        message: `/health failed: ${hbg.fetchError || `HTTP ${hbg.status || "?"}`}`,
        detail: enrichFetchFailedHint(base),
        ts: Date.now(),
      });
      return;
    }
    const pbg = await enricherProbeEnrichViaBackground(base, apiKey);
    if (pbg.ok) {
      appendLog({ level: "info", message: "/v1/enrich OK (empty rows probe).", ts: Date.now() });
      return;
    }
    appendLog({
      level: pbg.status === 401 ? "error" : "warn",
      message: `/v1/enrich ${pbg.status || "?"} — ${pbg.fetchError || ""} ${apiKey ? "" : "(cloud needs API key)"}`,
      detail: (pbg.textSnippet || "").slice(0, 200),
      ts: Date.now(),
    });
  });
}

const saveEnrichRemoteBtn = $("saveEnrichRemoteBtn");
if (saveEnrichRemoteBtn) {
  saveEnrichRemoteBtn.addEventListener("click", async () => {
    const { base, apiKey } = await readEnrichRemoteInputs();
    const perm = await ensureHostPermissionForUrl(base);
    if (!perm.ok) {
      appendLog({
        level: "error",
        message: "Host permission denied or invalid API URL — extension cannot call this origin.",
        detail: perm.err || perm.reason || "",
        ts: Date.now(),
      });
      return;
    }
    const target = getPanelEnrichTarget() || "local";
    const payload = {
      [STORAGE_ENRICH_KEY]: apiKey,
      [STORAGE_ENRICH_TARGET]: target,
    };
    if (target === "remote" || !enrichBaseLooksLocal(base)) {
      payload[STORAGE_ENRICH_BASE] = base;
    }
    chrome.storage.sync.set(payload, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          appendLog({ level: "error", message: err.message || "Save failed", ts: Date.now() });
          return;
        }
        appendLog({
          level: "info",
          message:
            target === "local"
              ? `Saved: using local ${DEFAULT_ENRICH_BASE}. Online URL was left as-is.`
              : "Saved online enrich API URL + key.",
          ts: Date.now(),
        });
        checkEnrichServerHealth();
      }
    );
  });
}

const useLocalInsteadBtn = $("useLocalInsteadBtn");
if (useLocalInsteadBtn) {
  useLocalInsteadBtn.addEventListener("click", () => selectEnrichTarget("local"));
}

const refreshEnrichHealthBtn = $("refreshEnrichHealthBtn");
if (refreshEnrichHealthBtn) {
  refreshEnrichHealthBtn.addEventListener("click", async () => {
    appendLog({ level: "info", message: "Checking enrich server (/health)…", ts: Date.now() });
    const up = await checkEnrichServerHealth();
    appendLog({
      level: up ? "info" : "warn",
      message: up ? "Enrich server responded to /health." : "Enrich server not reachable — try Local if the VPS is off.",
      ts: Date.now(),
    });
  });
}

function openLocalEnrichProtocolLink() {
  const a = document.createElement("a");
  a.href = "gmapsagent-enrich://start";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function startLocalEnrichServerFromPanel() {
  const btns = [$("startLocalServerBtn"), $("startEnrichServerNativeBtn")].filter(Boolean);
  btns.forEach((b) => {
    b.disabled = true;
  });
  appendLog({ level: "info", message: "Starting local enrich server…", ts: Date.now() });

  const finish = () => {
    btns.forEach((b) => {
      b.disabled = false;
    });
  };

  const pollUntilUp = async (startedVia) => {
    for (let i = 0; i < 14; i += 1) {
      await new Promise((r) => setTimeout(r, 700));
      const h = await enricherHealthViaBackground(DEFAULT_ENRICH_BASE);
      if (h.ok && h.json && h.json.ok === true) {
        appendLog({
          level: "info",
          message: `Local enrich server is up @ ${DEFAULT_ENRICH_BASE}${startedVia ? ` (${startedVia})` : ""}`,
          ts: Date.now(),
        });
        await checkEnrichServerHealth();
        return true;
      }
    }
    return false;
  };

  try {
    const already = await enricherHealthViaBackground(DEFAULT_ENRICH_BASE);
    if (already.ok && already.json && already.json.ok === true) {
      appendLog({
        level: "info",
        message: `Local server already running @ ${DEFAULT_ENRICH_BASE}`,
        ts: Date.now(),
      });
      await checkEnrichServerHealth();
      return true;
    }

    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action: "START_LOCAL_ENRICH_SERVER" }, (r) => {
          const le = chrome.runtime.lastError;
          resolve(le ? { ok: false, error: le.message } : r && typeof r === "object" ? r : { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });

    if (res.already_running) {
      appendLog({
        level: "info",
        message: `Local server already running @ ${DEFAULT_ENRICH_BASE}`,
        ts: Date.now(),
      });
      await checkEnrichServerHealth();
      return true;
    }

    if (res.via === "native" && res.ok) {
      const bits = [];
      if (res.already_running) bits.push("already running");
      else if (res.started) bits.push("launched console");
      if (res.server_up) bits.push("/health OK");
      appendLog({
        level: "info",
        message: `Native host: ${bits.join(" · ") || "ok"}`,
        ts: Date.now(),
      });
      if (res.server_up || (await pollUntilUp("native"))) return true;
    }

    if (res.needProtocolClick || res.via === "protocol" || !res.ok) {
      appendLog({
        level: "info",
        message: "Opening gmapsagent-enrich://start — allow Chrome’s “Open GmapsAgent Enrich” prompt if it appears.",
        ts: Date.now(),
      });
      openLocalEnrichProtocolLink();
    }

    const up = await pollUntilUp(res.via || "protocol");
    if (up) return true;

    appendLog({
      level: "error",
      message: "Local enrich server did not come up after Start.",
      detail: [
        res.nativeError || res.error || "",
        "If Chrome asked to open GmapsAgent Enrich, click Open / Allow.",
        `Or double-click: GmapsAgent\\EmailEnricher\\start_enrich_server.bat`,
        "Then click Check server.",
      ]
        .filter(Boolean)
        .join("\n"),
      ts: Date.now(),
    });
    await checkEnrichServerHealth();
    return false;
  } finally {
    finish();
  }
}

const startLocalServerBtn = $("startLocalServerBtn");
if (startLocalServerBtn) {
  startLocalServerBtn.addEventListener("click", () => startLocalEnrichServerFromPanel());
}

const startEnrichServerNativeBtn = $("startEnrichServerNativeBtn");
if (startEnrichServerNativeBtn) {
  startEnrichServerNativeBtn.addEventListener("click", () => startLocalEnrichServerFromPanel());
}

$("startBtn").addEventListener("click", async () => {
  $("logView").innerHTML = "";
  lineCount = 0;
  $("logCount").textContent = "0 lines";

  let keywords = readModeKeywords();

  if ($("mode").value === "file") {
    const f = $("batchFile").files?.[0];
    if (!f) {
      appendLog({ level: "error", message: "Choose a .txt file first.", ts: Date.now() });
      return;
    }
    try {
      const txt = await readFileAsText(f);
      keywords = parseLines(txt);
    } catch (e) {
      appendLog({ level: "error", message: "Could not read file.", detail: String(e), ts: Date.now() });
      return;
    }
  }

  if (!keywords?.length) {
    appendLog({ level: "error", message: "Add at least one non-empty search line.", ts: Date.now() });
    return;
  }

  const getAll = $("getAll").checked;
  const limitRaw = $("limit").value.trim();
  const limit = limitRaw ? parseInt(limitRaw, 10) : null;

  if (!getAll && (!limit || limit < 1)) {
    appendLog({
      level: "error",
      message: "Validation failed.",
      detail: "Set a positive max contacts, or enable GET ALL.",
      ts: Date.now(),
    });
    return;
  }
  if (!getAll && Number.isNaN(limit)) {
    appendLog({ level: "error", message: "Max contacts must be a number.", ts: Date.now() });
    return;
  }

  if (!mapsTabId) {
    await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "GET_TAB_ID" }, (res) => {
        mapsTabId = Number(res?.tabId) || 0;
        resolve();
      });
    });
  }

  setRunning(true);
  await acquireBatchWakeLock();
  appendLog({
    level: "info",
    message: `Queue started on this Maps tab${mapsTabId ? ` (#${mapsTabId})` : ""} · ${keywords.length} keyword(s) · getAll=${getAll} · limit=${getAll ? "n/a" : limit} · autoEnrich=${!!$("autoEnrich")?.checked} · oneCsv=${!!$("combineBatchCsv")?.checked && ($("mode")?.value === "paste" || $("mode")?.value === "file")} · refreshEvery=${$("mapsRefreshEvery3")?.checked ? 3 : 0}`,
    ts: Date.now(),
  });

  try {
    await new Promise((resolve, reject) => {
      chrome.storage.local.set(
        {
          [batchQueueStorageKey()]: {
            keywords,
            limit: getAll ? null : limit,
            getAll,
            autoEnrich: !!$("autoEnrich")?.checked,
            combineBatchCsv:
              !!$("combineBatchCsv")?.checked && ($("mode")?.value === "paste" || $("mode")?.value === "file"),
            mapsRefreshEvery: $("mapsRefreshEvery3")?.checked ? 3 : 0,
          },
        },
        () => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        }
      );
    });
  } catch (e) {
    appendLog({
      level: "error",
      message: "Could not store batch queue (list too large or storage unavailable).",
      detail: String(e?.message || e),
      ts: Date.now(),
    });
    await releaseBatchWakeLock();
    setRunning(false);
    return;
  }

  postToParent({
    type: "RUN_BATCH",
    payload: { fromStoredBatch: true, batchStorageKey: batchQueueStorageKey() },
  });
});

window.addEventListener("message", (event) => {
  if (!isTrustedMessengerOrigin(event.origin)) return;
  const d = event.data;
  if (!d || typeof d !== "object") return;

  if (d.type === "LOG") {
    appendLog(d);
    return;
  }
  if (d.type === "LEADS_UPDATE" && d.row) {
    const n = d.count || 0;
    $("leadsCount").textContent = `${n} rows`;
    const sidx = typeof d.sessionIndex === "number" ? d.sessionIndex : n - 1;
    appendLeadRow(d.row, sidx);
    return;
  }
  if (d.type === "LEADS_ROW_UPDATE" && d.row) {
    const n = d.count || 0;
    $("leadsCount").textContent = `${n} rows`;
    updateLeadRowBySessionIndex(d.index, d.row);
    return;
  }
  if (d.type === "LEADS_RESET") {
    resetLeadsTable();
    return;
  }
  if (d.type === "BATCH_PROGRESS") {
    const phase =
      d.phase === "enrich-all" ? "enriching all" : d.phase === "enrich" ? "enriching" : "scraping";
    const prog = `Keyword ${d.current}/${d.total} · ${d.leads || 0} leads · ${phase}`;
    $("leadsCount").textContent = prog;
    // Update document title so it's visible in the tab bar even when backgrounded
    try { document.title = `[${d.current}/${d.total}] Maps Scraper`; } catch (_) {}
    return;
  }
  if (d.type === "BATCH_RESUMED") {
    setRunning(true);
    acquireBatchWakeLock().catch(() => {});
    appendLog({
      level: "info",
      message: `Resumed after Maps refresh · continuing search ${d.current}/${d.total} · ${d.leads || 0} lead(s) restored`,
      detail: d.reason ? String(d.reason) : "",
      ts: Date.now(),
    });
    return;
  }
  if (d.type === "BATCH_DONE") {
    setRunning(false);
    releaseBatchWakeLock().catch(() => {});
    appendLog({
      level: d.ok === false ? "error" : "info",
      message:
        d.ok === false
          ? `Batch ended with error: ${d.error || "unknown"}`
          : d.combinedCsv
            ? "Batch finished. All searches were collected, then enriched, then one combined CSV was downloaded."
            : $("autoEnrich")?.checked
              ? "Batch finished. Each search was enriched (when the server was up) and its CSV downloaded; use Export session CSV for one combined file."
              : "Batch finished. Per-keyword CSVs were saved to Downloads; use Export session CSV for one combined file.",
      detail: d.error,
      ts: Date.now(),
    });
    return;
  }
  if (d.type === "HOST_VISIBILITY") {
    if (!d.visible) {
      $("shell").classList.add("hidden");
      $("rail").hidden = true;
    } else {
      const min = !!d.minimized;
      showShell(!min);
    }
    return;
  }
  if (d.type === "INIT_STATE") {
    if (d.mapsPageOrigin && typeof d.mapsPageOrigin === "string") window.__gmsMapsPageOrigin = d.mapsPageOrigin;
    if (d.tabId) mapsTabId = Number(d.tabId) || mapsTabId;
    $("verbose").checked = d.verbose !== false;
    if (d.minimized) showShell(false);
    else showShell(true);
    if (!window.__gmsReadyLogged) {
      window.__gmsReadyLogged = true;
      appendLog({ level: "info", message: "Panel ready · connected to Maps tab.", ts: Date.now() });
    }
    refreshSavedFolderFromStorage();
    applyEnrichRemoteInputsFromStorage();
    loadAutoEnrichToggle();
    loadCombineBatchToggle();
    loadMapsRefreshToggle();
    updateCombineBatchVisibility();
    checkEnrichServerHealth();
  }
  if (d.type === "ENRICH_AUTO_REQUEST") {
    const rows = Array.isArray(d.rows) ? d.rows : [];
    const keyword = d.keyword != null ? String(d.keyword) : "";
    (async () => {
      if (!rows.length) {
        postToParent({ type: "ENRICH_AUTO_DONE", ok: true, empty: true, keyword });
        return;
      }
      appendLog({
        level: "info",
        message: `Auto-enrich ${rows.length} row(s) for “${keyword}”…`,
        ts: Date.now(),
      });
      let up = await checkEnrichServerHealth();
      if (!up) {
        const { target } = await getEffectiveEnrichBaseAndKey();
        if (target === "local") {
          appendLog({
            level: "warn",
            message: "Auto-enrich: local server down — trying Start local server…",
            ts: Date.now(),
          });
          await startLocalEnrichServerFromPanel();
          up = await checkEnrichServerHealth();
        }
      }
      if (!up) {
        appendLog({
          level: "warn",
          message: "Auto-enrich skipped — enrich server unreachable. Downloading this search without emails, then next query.",
          ts: Date.now(),
        });
        postToParent({ type: "ENRICH_AUTO_DONE", ok: false, error: "server_down", keyword });
        return;
      }
      const finished = await runEnrichStream(rows);
      postToParent({ type: "ENRICH_AUTO_DONE", ok: !!finished, keyword });
    })();
    return;
  }
  if (d.type === "ENRICH_PAYLOAD") {
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) {
      appendLog({
        level: "warn",
        message: "Nothing to enrich — session table is empty.",
        ts: Date.now(),
      });
      return;
    }
    appendLog({
      level: "info",
      message: `Enriching ${rows.length} row(s) via /v1/enrich…`,
      ts: Date.now(),
    });
    runEnrichStream(rows);
  }
});

const batchFileEl = $("batchFile");
if (batchFileEl) {
  batchFileEl.addEventListener("change", async () => {
    const hint = $("batchFileLineHint");
    const f = batchFileEl.files?.[0];
    if (!f) {
      if (hint) hint.textContent = "";
      return;
    }
    try {
      const txt = await readFileAsText(f);
      const n = parseLines(txt).length;
      if (hint) {
        hint.textContent = `${n} non-empty line(s) — each line runs as its own search when you Start queue.`;
      }
    } catch {
      if (hint) hint.textContent = "Could not read file for preview.";
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && $("startBtn")?.disabled) {
    acquireBatchWakeLock().catch(() => {});
  }
});

const autoEnrichEl = $("autoEnrich");
if (autoEnrichEl) {
  autoEnrichEl.addEventListener("change", () => persistAutoEnrichToggle());
}
const combineBatchEl = $("combineBatchCsv");
if (combineBatchEl) {
  combineBatchEl.addEventListener("change", () => persistCombineBatchToggle());
}

postToParent({ type: "PANEL_READY" });
refreshSavedFolderFromStorage();
applyEnrichRemoteInputsFromStorage();
loadAutoEnrichToggle();
loadCombineBatchToggle();
loadMapsRefreshToggle();
updateCombineBatchVisibility();
checkEnrichServerHealth();
const mapsRefreshEl = $("mapsRefreshEvery3");
if (mapsRefreshEl) {
  mapsRefreshEl.addEventListener("change", () => persistMapsRefreshToggle());
}
