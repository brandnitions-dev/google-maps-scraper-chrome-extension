const STORAGE_KEY = "emailEnricherDir";
const STORAGE_ENRICH_BASE = "enrichApiBaseUrl";
const STORAGE_ENRICH_KEY = "enrichApiKey";
const STORAGE_ENRICH_TARGET = "enrichApiTarget";
const DEFAULT_ENRICH_BASE = "http://127.0.0.1:18765";

function $(id) {
  return document.getElementById(id);
}

function normalizeDir(s) {
  return String(s ?? "")
    .trim()
    .replace(/[/\\]+$/, "");
}

function normalizeEnrichBase(s) {
  const t = String(s ?? "")
    .trim()
    .replace(/[/\\]+$/, "");
  return t || DEFAULT_ENRICH_BASE;
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

function inferEnrichTargetFromBase(base) {
  return enrichBaseLooksLocal(base) ? "local" : "remote";
}

function getSelectedTarget() {
  return $("enrichTargetRemote")?.checked ? "remote" : "local";
}

function setSelectedTarget(target) {
  const isRemote = target === "remote";
  if ($("enrichTargetLocal")) $("enrichTargetLocal").checked = !isRemote;
  if ($("enrichTargetRemote")) $("enrichTargetRemote").checked = isRemote;
}

function setStatus(msg, ok) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("ok", !!ok);
}

function setEnrichStatus(msg, ok) {
  const el = $("enrichStatus");
  el.textContent = msg;
  el.classList.toggle("ok", !!ok);
}

function load() {
  chrome.storage.sync.get([STORAGE_KEY, STORAGE_ENRICH_BASE, STORAGE_ENRICH_KEY, STORAGE_ENRICH_TARGET], (r) => {
    $("emailEnricherDir").value = normalizeDir(r[STORAGE_KEY]);
    const base = normalizeEnrichBase(r[STORAGE_ENRICH_BASE]);
    if (!enrichBaseLooksLocal(base)) $("enrichApiBaseUrl").value = base;
    else $("enrichApiBaseUrl").value = "";
    $("enrichApiKey").value = String(r[STORAGE_ENRICH_KEY] ?? "");
    const target =
      r[STORAGE_ENRICH_TARGET] === "local" || r[STORAGE_ENRICH_TARGET] === "remote"
        ? r[STORAGE_ENRICH_TARGET]
        : inferEnrichTargetFromBase(r[STORAGE_ENRICH_BASE] == null ? DEFAULT_ENRICH_BASE : base);
    setSelectedTarget(target);
    setStatus("");
    setEnrichStatus("");
  });
}

function ensureHostPermissionForUrl(baseUrl, cb) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    cb(false, "bad_url");
    return;
  }
  if (origin === "http://127.0.0.1:18765" || origin === "http://localhost:18765") {
    cb(true);
    return;
  }
  const perm = chrome.permissions;
  if (!perm || !perm.request) {
    cb(true);
    return;
  }
  perm.request({ origins: [`${origin}/*`] }, (granted) => {
    const err = chrome.runtime.lastError;
    cb(!!granted && !err, err?.message);
  });
}

$("saveEnrichBtn").addEventListener("click", () => {
  const typed = String($("enrichApiBaseUrl").value ?? "").trim();
  const base = typed ? normalizeEnrichBase(typed) : "";
  const apiKey = String($("enrichApiKey").value ?? "").trim();
  const target = getSelectedTarget();
  const permUrl = target === "local" ? DEFAULT_ENRICH_BASE : base || DEFAULT_ENRICH_BASE;
  ensureHostPermissionForUrl(permUrl, (ok, errMsg) => {
    if (!ok) {
      setEnrichStatus(errMsg || "Host permission denied — check API URL.", false);
      return;
    }
    const payload = {
      [STORAGE_ENRICH_KEY]: apiKey,
      [STORAGE_ENRICH_TARGET]: target,
    };
    if (base && !enrichBaseLooksLocal(base)) {
      payload[STORAGE_ENRICH_BASE] = base;
    }
    chrome.storage.sync.set(payload, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        setEnrichStatus(err.message || "Save failed.");
        return;
      }
      if (base && !enrichBaseLooksLocal(base)) $("enrichApiBaseUrl").value = base;
      setSelectedTarget(target);
      setEnrichStatus(
        target === "local"
          ? `Saved. Active target: local ${DEFAULT_ENRICH_BASE}. Online URL kept separately.`
          : "Saved online enrich URL + key.",
        true
      );
    });
  });
});

$("saveBtn").addEventListener("click", () => {
  const trimmed = normalizeDir($("emailEnricherDir").value);
  chrome.storage.sync.set({ [STORAGE_KEY]: trimmed }, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      setStatus(err.message || "Save failed.");
      return;
    }
    $("emailEnricherDir").value = trimmed;
    setStatus(trimmed ? "Saved." : "Cleared (empty path).", true);
  });
});

$("clearBtn").addEventListener("click", () => {
  $("emailEnricherDir").value = "";
  chrome.storage.sync.set({ [STORAGE_KEY]: "" }, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      setStatus(err.message || "Clear failed.");
      return;
    }
    setStatus("Cleared.", true);
  });
});

load();
