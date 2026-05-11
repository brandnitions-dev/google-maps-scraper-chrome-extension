const STOP_KEY = "scrapeStopRequested";

function escapeCsvCell(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  const headers = ["search_query", "title", "address", "phone", "website_url"];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvCell(row.search_query),
        escapeCsvCell(row.title),
        escapeCsvCell(row.address),
        escapeCsvCell(row.phone),
        escapeCsvCell(row.website_url),
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
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `maps_${safeFilePart(keyword)}_${stamp}.csv`;
  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: false,
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
      await downloadKeywordCsv(message.keyword, rows);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.action === "CLEAR_STOP") {
    chrome.storage.local.set({ [STOP_KEY]: false }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "REQUEST_STOP") {
    chrome.storage.local.set({ [STOP_KEY]: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "GET_STOP") {
    chrome.storage.local.get(STOP_KEY).then((v) => sendResponse({ stop: !!v[STOP_KEY] }));
    return true;
  }
  return false;
});
