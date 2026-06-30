const STORAGE_KEY = "emailEnricherDir";
const STORAGE_ENRICH_BASE = "enrichApiBaseUrl";
const STORAGE_ENRICH_KEY = "enrichApiKey";
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
  chrome.storage.sync.get([STORAGE_KEY, STORAGE_ENRICH_BASE, STORAGE_ENRICH_KEY], (r) => {
    $("emailEnricherDir").value = normalizeDir(r[STORAGE_KEY]);
    $("enrichApiBaseUrl").value = normalizeEnrichBase(r[STORAGE_ENRICH_BASE]);
    $("enrichApiKey").value = String(r[STORAGE_ENRICH_KEY] ?? "");
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
  const base = normalizeEnrichBase($("enrichApiBaseUrl").value);
  const apiKey = String($("enrichApiKey").value ?? "").trim();
  ensureHostPermissionForUrl(base, (ok, errMsg) => {
    if (!ok) {
      setEnrichStatus(errMsg || "Host permission denied — check API URL.", false);
      return;
    }
    chrome.storage.sync.set(
      {
        [STORAGE_ENRICH_BASE]: base,
        [STORAGE_ENRICH_KEY]: apiKey,
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          setEnrichStatus(err.message || "Save failed.");
          return;
        }
        $("enrichApiBaseUrl").value = base;
        setEnrichStatus("Saved enrich URL + key.", true);
      }
    );
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
