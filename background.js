const STOP_KEY_PREFIX = "gms_stop_";
const BATCH_TABS_KEY = "gms_batch_tab_ids";
const LEGACY_STOP_KEY = "scrapeStopRequested";
const BATCH_ACTIVE_KEY = "gms_batch_active";

/** Keep-alive alarm: pings every running Maps tab so background/minimized queues keep moving. */
const KEEPALIVE_ALARM = "gms_keepalive";

function stopStorageKey(tabId) {
  return STOP_KEY_PREFIX + String(tabId);
}

async function readBatchTabIds() {
  const got = await chrome.storage.local.get(BATCH_TABS_KEY);
  const raw = got[BATCH_TABS_KEY];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((n) => Number(n)).filter((n) => n > 0))];
}

async function writeBatchTabIds(ids) {
  const uniq = [...new Set(ids.map((n) => Number(n)).filter((n) => n > 0))];
  await chrome.storage.local.set({
    [BATCH_TABS_KEY]: uniq,
    [BATCH_ACTIVE_KEY]: uniq.length > 0,
  });
  return uniq;
}

async function addBatchTab(tabId) {
  if (!tabId) return;
  const ids = await readBatchTabIds();
  if (!ids.includes(tabId)) ids.push(tabId);
  await writeBatchTabIds(ids);
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  try {
    await chrome.tabs.update(tabId, { autoDiscardable: false });
  } catch (_) {}
}

async function removeBatchTab(tabId) {
  if (!tabId) return;
  const ids = (await readBatchTabIds()).filter((id) => id !== tabId);
  await writeBatchTabIds(ids);
  if (!ids.length) await chrome.alarms.clear(KEEPALIVE_ALARM);
}

async function pingAllBatchTabs() {
  const ids = await readBatchTabIds();
  if (!ids.length) {
    await chrome.alarms.clear(KEEPALIVE_ALARM);
    return;
  }
  const alive = [];
  await Promise.all(
    ids.map(
      (id) =>
        new Promise((resolve) => {
          chrome.tabs.sendMessage(id, { action: "PING", ts: Date.now() }, () => {
            if (chrome.runtime.lastError) {
              resolve(false);
              return;
            }
            alive.push(id);
            resolve(true);
          });
        })
    )
  );
  if (alive.length !== ids.length) await writeBatchTabIds(alive);
  if (!alive.length) await chrome.alarms.clear(KEEPALIVE_ALARM);
}

function ensureKeepAliveAlarm() {
  readBatchTabIds().then((ids) => {
    if (ids.length) chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  });
}

ensureKeepAliveAlarm();

function escapeCsvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  const headers = ["search_query", "title", "address", "phone", "website_url", "email"];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvCell(row.search_query),
        escapeCsvCell(row.title),
        escapeCsvCell(row.address),
        escapeCsvCell(row.phone),
        escapeCsvCell(row.website_url),
        escapeCsvCell(row.email),
      ].join(",")
    );
  }
  return "\ufeff" + lines.join("\r\n");
}

function safeFilePart(name) {
  const cleaned = String(name || "search")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);
  return cleaned || "search";
}

async function downloadKeywordCsv(keyword, rows) {
  const csv = rowsToCsv(rows);
  const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `maps_${safeFilePart(keyword)}_${stamp}.csv`;
  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
    });
  } catch (e) {
    console.error("Failed to download keyword CSV", e);
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  if (!tab.url?.includes("google.com/maps")) return;
  chrome.tabs.sendMessage(tab.id, { action: "TOGGLE_HOST_VISIBILITY" }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "DOWNLOAD_SESSION_CSV") {
    (async () => {
      const rows = message.rows || [];
      if (!rows.length) {
        sendResponse({ ok: false, error: "empty" });
        return;
      }
      const csv = rowsToCsv(rows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      let url = "";
      try {
        url = URL.createObjectURL(blob);
      } catch (_) {
        url = "";
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = safeFilePart(message.filename || "maps_session") + "_" + stamp + ".csv";
      try {
        if (url) {
          await chrome.downloads.download({ url, filename, saveAs: false });
        } else {
          const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
          await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
        }
        sendResponse({ ok: true });
      } catch (e1) {
        try {
          const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
          await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
          sendResponse({ ok: true });
        } catch (e2) {
          sendResponse({ ok: false, error: String(e2?.message || e2 || e1?.message || e1) });
        }
      } finally {
        if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    })();
    return true;
  }
  if (message?.action === "KEYWORD_DONE") {
    (async () => {
      const rows = message.rows || [];
      if (!rows.length) {
        sendResponse({ ok: true, skipped: true });
        return;
      }
      try {
        await downloadKeywordCsv(message.keyword, rows);
      } catch (e) {
        console.error("CSV save error", e);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.action === "GET_TAB_ID") {
    sendResponse({ tabId: sender?.tab?.id || 0 });
    return true;
  }
  if (message?.action === "CLEAR_STOP") {
    const tabId = sender?.tab?.id;
    const patch = { [LEGACY_STOP_KEY]: false };
    if (tabId) patch[stopStorageKey(tabId)] = false;
    chrome.storage.local.set(patch).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "REQUEST_STOP") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "no_tab" });
      return true;
    }
    chrome.storage.local.set({ [stopStorageKey(tabId)]: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "GET_STOP") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ stop: false });
      return true;
    }
    chrome.storage.local.get(stopStorageKey(tabId)).then((v) => sendResponse({ stop: !!v[stopStorageKey(tabId)] }));
    return true;
  }
  if (message?.action === "KEEPALIVE") {
    if (sender?.tab?.id) addBatchTab(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }
  if (message?.action === "BATCH_STARTED") {
    addBatchTab(sender?.tab?.id || 0).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "BATCH_ENDED") {
    removeBatchTab(sender?.tab?.id || 0).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "ENRICHER_HEALTH") {
    (async () => {
      const base = String(message.baseUrl || "").replace(/\/+$/, "");
      if (!base) {
        sendResponse({ ok: false, reason: "no_base" });
        return;
      }
      try {
        const r = await fetch(`${base}/health`, { method: "GET", cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        sendResponse({
          ok: r.ok && j && j.ok === true,
          status: r.status,
          json: j,
        });
      } catch (e) {
        sendResponse({
          ok: false,
          fetchError: String(e?.message || e),
        });
      }
    })();
    return true;
  }
  if (message?.action === "ENRICHER_PROBE_ENRICH") {
    (async () => {
      const base = String(message.baseUrl || "").replace(/\/+$/, "");
      const apiKey = message.apiKey ? String(message.apiKey).trim() : "";
      if (!base) {
        sendResponse({ ok: false, reason: "no_base" });
        return;
      }
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      try {
        const r = await fetch(`${base}/v1/enrich`, {
          method: "POST",
          headers,
          body: JSON.stringify({ rows: [] }),
          cache: "no-store",
        });
        const txt = r.ok ? "" : await r.text().catch(() => "");
        sendResponse({ ok: r.ok, status: r.status, textSnippet: txt.slice(0, 300) });
      } catch (e) {
        sendResponse({ ok: false, fetchError: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (message?.action === "START_LOCAL_ENRICH_SERVER") {
    (async () => {
      const host = "com.gmapsagent.enrich";
      try {
        const r = await fetch("http://127.0.0.1:18765/health", { method: "GET", cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j && j.ok === true) {
          sendResponse({ ok: true, already_running: true, via: "health" });
          return;
        }
      } catch (_) {
        /* not up yet */
      }

      const native = await new Promise((resolve) => {
        try {
          chrome.runtime.sendNativeMessage(host, { cmd: "start_server" }, (response) => {
            const err = chrome.runtime.lastError;
            if (err) resolve({ ok: false, error: err.message });
            else resolve(response && typeof response === "object" ? response : { ok: false });
          });
        } catch (e) {
          resolve({ ok: false, error: String(e?.message || e) });
        }
      });
      if (native.ok) {
        sendResponse({ ok: true, via: "native", ...native });
        return;
      }

      let protocolOk = false;
      let protocolError = "";
      try {
        const tab = await chrome.tabs.create({ url: "gmapsagent-enrich://start", active: false });
        protocolOk = true;
        if (tab?.id) {
          const tabId = tab.id;
          setTimeout(() => {
            chrome.tabs.remove(tabId).catch(() => {});
          }, 2500);
        }
      } catch (e) {
        protocolError = String(e?.message || e);
      }
      sendResponse({
        ok: protocolOk,
        via: "protocol",
        needProtocolClick: true,
        nativeError: native.error || "",
        error: protocolOk ? "" : protocolError || native.error || "start_failed",
      });
    })();
    return true;
  }
  return false;
});

function consumeSseBlocks(buffer) {
  const events = [];
  let rest = buffer;
  let sep;
  while ((sep = rest.indexOf("\n\n")) !== -1) {
    const block = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    let eventName = "message";
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const raw = dataLines.join("\n");
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
    events.push({ event: eventName, data });
  }
  return { events, rest };
}

/** Panel iframe on Maps cannot reliably fetch remote /v1/enrich; stream here and forward over port. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ENRICH_STREAM") return;
  let started = false;
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "START" || started) return;
    started = true;
    (async () => {
      let sawDone = false;
      const base = String(msg.baseUrl || "").replace(/\/+$/, "");
      const apiKey = String(msg.apiKey || "").trim();
      const rows = Array.isArray(msg.rows) ? msg.rows : [];
      if (!base || !rows.length) {
        try {
          port.postMessage({ type: "PROBLEM", kind: "bad_args", message: "missing base or rows" });
        } catch (_) {}
        try {
          port.postMessage({ type: "END", sawDone: false });
        } catch (_) {}
        return;
      }
      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      try {
        const res = await fetch(`${base}/v1/enrich`, {
          method: "POST",
          headers,
          body: JSON.stringify({ rows }),
          cache: "no-store",
        });
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          try {
            port.postMessage({
              type: "PROBLEM",
              kind: "http",
              status: res.status,
              text: t.slice(0, 600),
            });
          } catch (_) {}
          return;
        }
        const reader = res.body?.getReader?.();
        if (!reader) {
          try {
            port.postMessage({ type: "PROBLEM", kind: "fetch", message: "no response body reader" });
          } catch (_) {}
          return;
        }
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          const parsed = consumeSseBlocks(buf);
          buf = parsed.rest;
          for (const ev of parsed.events) {
            if (ev.event === "row" && ev.data && typeof ev.data.index === "number") {
              try {
                port.postMessage({
                  type: "ROW",
                  index: ev.data.index,
                  email: ev.data.email != null ? String(ev.data.email) : "",
                  error: ev.data.error ? String(ev.data.error) : "",
                });
              } catch (_) {
                return;
              }
            } else if (ev.event === "done") {
              sawDone = true;
            }
          }
        }
        buf += dec.decode();
        const tail = consumeSseBlocks(buf);
        for (const ev of tail.events) {
          if (ev.event === "row" && ev.data && typeof ev.data.index === "number") {
            try {
              port.postMessage({
                type: "ROW",
                index: ev.data.index,
                email: ev.data.email != null ? String(ev.data.email) : "",
                error: ev.data.error ? String(ev.data.error) : "",
              });
            } catch (_) {
              return;
            }
          } else if (ev.event === "done") {
            sawDone = true;
          }
        }
      } catch (e) {
        try {
          port.postMessage({ type: "PROBLEM", kind: "fetch", message: String(e?.message || e) });
        } catch (_) {}
      } finally {
        try {
          port.postMessage({ type: "END", sawDone });
        } catch (_) {}
      }
    })();
  });
});

/** Alarm-based keep-alive: ping every running Maps tab (not just one). */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  pingAllBatchTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeBatchTab(tabId);
  chrome.storage.local.remove(stopStorageKey(tabId));
});
