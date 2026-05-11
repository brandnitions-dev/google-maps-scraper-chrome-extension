const MAX_LINES = 600;

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

function parseLines(text) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
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
  postToParent({ type: "STOP" });
  appendLog({ level: "warn", message: "Stop requested — finishes current listing then halts.", ts: Date.now() });
});

function resetLeadsTable() {
  $("leadsBody").innerHTML = "";
  $("leadsCount").textContent = "0 rows";
}

function appendLeadRow(row, sessionIndex) {
  const tbody = $("leadsBody");
  const tr = document.createElement("tr");
  tr.dataset.sidx = String(sessionIndex);
  const displayNum = sessionIndex + 1;
  const cols = [String(displayNum), row.search_query || "", row.title || "", row.phone || "", row.website_url || ""];
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
  const cols = [String(displayNum), row.search_query || "", row.title || "", row.phone || "", row.website_url || ""];
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

  setRunning(true);
  appendLog({
    level: "info",
    message: `Queue started · ${keywords.length} keyword(s) · getAll=${getAll} · limit=${getAll ? "n/a" : limit}`,
    ts: Date.now(),
  });

  postToParent({
    type: "RUN_BATCH",
    payload: {
      keywords,
      limit: getAll ? null : limit,
      getAll,
    },
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
  if (d.type === "BATCH_DONE") {
    setRunning(false);
    appendLog({
      level: d.ok === false ? "error" : "info",
      message:
        d.ok === false
          ? `Batch ended with error: ${d.error || "unknown"}`
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
    $("verbose").checked = d.verbose !== false;
    if (d.minimized) showShell(false);
    else showShell(true);
    if (!window.__gmsReadyLogged) {
      window.__gmsReadyLogged = true;
      appendLog({ level: "info", message: "Panel ready · connected to Maps tab.", ts: Date.now() });
    }
  }
});

postToParent({ type: "PANEL_READY" });
