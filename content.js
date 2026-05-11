const HOST_ID = "gms-scraper-dock";
const STORAGE_VISIBLE = "gms_host_visible";
const STORAGE_MIN = "gms_minimized";
const STORAGE_VERBOSE = "gms_verbose";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extOrigin() {
  return new URL(chrome.runtime.getURL("/")).origin;
}

function postToPanel(msg) {
  const win = iframeEl?.contentWindow;
  if (!win) return;
  try {
    win.postMessage(msg, extOrigin());
  } catch (e) {
    console.warn("[Maps scraper] postToPanel failed", e);
  }
}

function debugLog(level, message, detail) {
  postToPanel({ type: "LOG", level, message, detail, ts: Date.now() });
}

let iframeEl = null;
let hostEl = null;
let batchRunning = false;
/** All rows collected in this Maps tab since last “Start queue” (survives Stop). */
let sessionLeads = [];

async function isStopped() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "GET_STOP" }, (res) => {
      resolve(!!res?.stop);
    });
  });
}

function normalizeText(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2011\u2012\u2013\u2014\u2212]/g, "-")
    .trim();
}

/** Maps shows phones like +1 305-767-7064 inside div.Io6YTe only (no data-item-id). */
function looksLikePhone(s) {
  const t = normalizeText(s);
  if (t.length < 8) return false;
  const digits = t.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 18) return false;
  if (/https?:\/\//i.test(t)) return false;
  const phoneish = /^[\d\s+().\-extEXT,]+$/i.test(t);
  if (!phoneish) return false;
  return true;
}

function looksLikeDomainLine(s) {
  const t = normalizeText(s);
  if (!t || t.includes(" ") || t.includes(",")) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(t.replace(/^www\./i, ""));
}

/** Address lines: "8572 SW 8th St, Miami, FL 33144, United States" */
function looksLikeAddress(s) {
  const t = normalizeText(s);
  if (t.length < 8) return false;
  if (looksLikePhone(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (looksLikeDomainLine(t)) return false;
  if (/^\(?\d+\)?\s*\d+\s*stars?/i.test(t)) return false;
  if (/\b(opens?|closed|hours?)\b/i.test(t) && !/\d{5}/.test(t) && !/\b(st|street|ave|rd)\b/i.test(t))
    return false;
  if (/,/.test(t) && /[a-zA-Z]/.test(t)) return true;
  if (/\b(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|ct|fl|suite|unit)\b/i.test(t)) return true;
  if (/\b\d{5}(-\d{4})?\b/.test(t)) return true;
  if (/\b(united states|usa|canada|uk|u\.k\.)\b/i.test(t)) return true;
  return t.length > 20 && /[a-zA-Z]{3,}/.test(t) && /\d/.test(t);
}

function getPlaceDetailRoot() {
  const h1 = document.querySelector("h1.DUwDvf");
  if (!h1) return document.querySelector('[role="main"]') || document.body;
  let el = h1.closest("div.m6QErb");
  if (el && el.getAttribute("role") === "feed") el = null;
  if (el) return el;
  let p = h1.parentElement;
  for (let i = 0; i < 22 && p; i++) {
    if (p.classList?.contains("m6QErb") && p.getAttribute("role") !== "feed") return p;
    p = p.parentElement;
  }
  return h1.parentElement || document.querySelector('[role="main"]') || document.body;
}

function normalizeWebsiteUrl(textOrHref) {
  const raw = String(textOrHref || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return "https:" + raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw.replace(/^www\./i, ""))) {
    return "https://" + raw.replace(/^\/\//, "").replace(/^\/*/, "");
  }
  return "";
}

function isExternalBusinessWebsiteHref(href) {
  if (!href || typeof href !== "string") return false;
  try {
    const u = new URL(href);
    if (!/^https?:$/i.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === "maps.google.com" || h === "www.google.com" || h === "google.com") return false;
    if (h.endsWith(".google.com")) return false;
    if (h === "goo.gl" || h.endsWith(".goo.gl")) return false;
    return true;
  } catch {
    return false;
  }
}

function websiteFromAriaLabel(el) {
  const label = normalizeText(el?.getAttribute?.("aria-label") || "");
  const m = label.match(/^website:\s*(\S+)/i);
  if (!m) return "";
  return normalizeWebsiteUrl(m[1]);
}

function pickBestWebsiteAnchor(scopes) {
  const candidates = [];
  const visit = (root) => {
    if (!root || !root.querySelectorAll) return;
    const pushHref = (a) => {
      const href = a?.href || "";
      if (isExternalBusinessWebsiteHref(href)) candidates.push(href);
    };
    try {
      root.querySelectorAll('a.CsEnBe[data-item-id="authority"]').forEach(pushHref);
      root.querySelectorAll('a[data-item-id="authority"]').forEach(pushHref);
      root.querySelectorAll('a[aria-label^="Website:"], a[aria-label^="Website :"]').forEach(pushHref);
      root
        .querySelectorAll('a[href^="http"][aria-label="Open website"], a[href^="https"][aria-label="Open website"]')
        .forEach(pushHref);
      root.querySelectorAll('a.lcr4fd[href^="http"][data-tooltip="Open website"]').forEach(pushHref);
      root
        .querySelectorAll('div.RcCsl a[href^="http"], div.RcCsl a[href^="https"]')
        .forEach((a) => {
          if (websiteFromAriaLabel(a) || a.getAttribute("data-item-id") === "authority") pushHref(a);
        });
    } catch (_) {}
  };
  for (const s of scopes) visit(s);
  if (candidates.length) return candidates[0];
  for (const s of scopes) {
    try {
      const a =
        s?.querySelector?.('a.CsEnBe[data-item-id="authority"]') ||
        s?.querySelector?.('a[aria-label^="Website"]') ||
        s?.querySelector?.('a[aria-label^="Website:"]');
      const fromLabel = websiteFromAriaLabel(a);
      if (fromLabel) return fromLabel;
    } catch (_) {}
  }
  return "";
}

/**
 * Spec: div.Io6YTe.fontBodyMedium.kR99db.fdkmkc for address & phone text;
 * a.CsEnBe[data-item-id=authority] for website.
 */
function scrapeDetailPanel() {
  const root = getPlaceDetailRoot();
  const globalMain = document.querySelector('[role="main"]') || document.body;
  const websiteScopes = [root, globalMain, document.body].filter(Boolean);

  let title =
    document.querySelector("h1.DUwDvf")?.textContent?.trim() ||
    document.querySelector("h1.fontHeadlineLarge")?.textContent?.trim() ||
    root.querySelector("h1")?.textContent?.trim() ||
    "";

  if (!title) {
    const headline = document.querySelector(".qBF1Pd.fontHeadlineSmall");
    title = headline?.textContent?.trim() || "";
  }

  let address = "";
  let phone = "";

  const tryPhone = (t) => {
    const v = normalizeText(t);
    if (v && looksLikePhone(v) && !phone) phone = v;
  };
  const tryAddress = (t) => {
    const v = normalizeText(t);
    if (v && looksLikeAddress(v) && !address) address = v;
  };

  const phoneBtn = root.querySelector('button[data-item-id="phone"], a[data-item-id="phone"]');
  tryPhone(phoneBtn?.textContent);
  const addrBtn = root.querySelector('button[data-item-id="address"], [data-item-id="address"]');
  const addrIo = addrBtn?.querySelector?.(".Io6YTe") || addrBtn;
  tryAddress(addrIo?.textContent);

  const telA = root.querySelector('a[href^="tel:"]');
  tryPhone(telA?.textContent);
  if (!phone && telA?.href) tryPhone(telA.href.replace(/^tel:/i, ""));

  const detailSelectors = [
    "div.Io6YTe.fontBodyMedium.kR99db.fdkmkc",
    "div.Io6YTe.kR99db.fdkmkc",
    "div.Io6YTe.fontBodyMedium.kR99db",
    "button[data-item-id] .Io6YTe",
    ".rogA2c .Io6YTe",
  ];
  const seen = new Set();
  for (const sel of detailSelectors) {
    root.querySelectorAll(sel).forEach((el) => {
      if (el.closest?.('div[role="feed"]')) return;
      const tx = normalizeText(el.textContent);
      if (!tx || tx.length < 6 || seen.has(tx)) return;
      seen.add(tx);
      if (looksLikePhone(tx)) tryPhone(tx);
      else if (looksLikeAddress(tx)) tryAddress(tx);
    });
  }

  if (!phone) {
    root.querySelectorAll(".UsdlK").forEach((el) => tryPhone(el.textContent));
  }

  let website_url = pickBestWebsiteAnchor(websiteScopes);

  if (!website_url) {
    const w =
      root.querySelector('a[aria-label^="Website"]') ||
      globalMain.querySelector('a[aria-label^="Website"]') ||
      document.querySelector('a[aria-label^="Website"]');
    website_url = w?.href && isExternalBusinessWebsiteHref(w.href) ? w.href : websiteFromAriaLabel(w) || "";
  }

  if (!website_url) {
    const hostEl =
      root.querySelector(".rogA2c.ITvuef .Io6YTe") ||
      root.querySelector(".ITvuef .Io6YTe") ||
      globalMain.querySelector(".rogA2c.ITvuef .Io6YTe") ||
      document.querySelector(".rogA2c.ITvuef .Io6YTe");
    const hostTx = hostEl?.textContent?.trim() || "";
    if (hostTx && looksLikeDomainLine(hostTx)) website_url = normalizeWebsiteUrl(hostTx);
  }

  return { title, address, phone, website_url };
}

function detailPanelHasUsableWebsite() {
  const scopes = [getPlaceDetailRoot(), document.querySelector('[role="main"]'), document.body].filter(Boolean);
  if (pickBestWebsiteAnchor(scopes)) return true;
  try {
    for (const s of scopes) {
      const auth = s?.querySelector?.('a[data-item-id="authority"]');
      if (auth && (isExternalBusinessWebsiteHref(auth.href) || websiteFromAriaLabel(auth))) return true;
      const host = s?.querySelector?.(".rogA2c.ITvuef .Io6YTe");
      const tx = normalizeText(host?.textContent || "");
      if (tx && looksLikeDomainLine(tx)) return true;
    }
  } catch (_) {}
  return false;
}

async function waitForDetailPane(timeoutMs = 5500) {
  const start = Date.now();
  let sawCoreFieldsAt = 0;
  while (Date.now() - start < timeoutMs) {
    const r = getPlaceDetailRoot();
    const hasTitle = !!document.querySelector("h1.DUwDvf");
    const hasIo =
      r.querySelector("div.Io6YTe.fontBodyMedium.kR99db.fdkmkc") ||
      r.querySelector("div.Io6YTe.kR99db.fdkmkc") ||
      r.querySelector('button[data-item-id="phone"]') ||
      r.querySelector('a[href^="tel:"]') ||
      r.querySelector('[data-item-id="address"]');

    if (hasTitle && detailPanelHasUsableWebsite()) return;

    if (hasTitle && hasIo) {
      if (!sawCoreFieldsAt) sawCoreFieldsAt = Date.now();
      if (Date.now() - sawCoreFieldsAt > 1400) return;
    } else {
      sawCoreFieldsAt = 0;
    }

    if (
      hasTitle &&
      !hasIo &&
      (document.querySelector('a[data-item-id="authority"]') || document.querySelector(".rogA2c.ITvuef"))
    )
      return;

    await sleep(140);
  }
}

async function waitForFeed(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;
    await sleep(300);
  }
  throw new Error("Results feed not found — stay on the map search view.");
}

function listEndVisible() {
  const end = document.querySelector(".HlvSq");
  return !!(end && /end of the list/i.test(end.textContent || ""));
}

const SEARCH_SELECTORS = [
  "#searchboxinput",
  'input#searchboxinput[name="q"]',
  'input[name="q"][role="combobox"]',
  "input.searchboxinput",
  'input[jsaction*="omnibox"]',
  'textarea#searchboxinput',
  'input[aria-label*="Search"][role="combobox"]',
  'input[placeholder*="Search"]',
];

function querySelectorAllDeep(root, selector) {
  const out = [];
  const visit = (node) => {
    if (!node || !node.querySelectorAll) return;
    try {
      node.querySelectorAll(selector).forEach((el) => out.push(el));
    } catch (_) {}
    try {
      node.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    } catch (_) {}
  };
  visit(root);
  return out;
}

function findSearchInputOnce(elapsedMs) {
  for (const sel of SEARCH_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return el;
  }
  const anyCombobox = document.querySelector('input[role="combobox"][name="q"]');
  if (anyCombobox) return anyCombobox;
  if (elapsedMs < 2000) return null;
  for (const sel of SEARCH_SELECTORS) {
    const deep = querySelectorAllDeep(document.documentElement, sel);
    const pick = deep.find((n) => n.tagName === "INPUT" || n.tagName === "TEXTAREA");
    if (pick) return pick;
  }
  return null;
}

function setNativeInputValue(el, value) {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

async function waitForSearchInput(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    const el = findSearchInputOnce(elapsed);
    if (el) return el;
    await sleep(200);
  }
  throw new Error(
    "Maps search box not found (waited " +
      timeoutMs +
      "ms). Stay on https://www.google.com/maps map view and wait until the top search bar loads."
  );
}

async function runSearch(keyword) {
  debugLog("info", `Search submitted`, keyword);
  debugLog("debug", "Waiting for omnibox…");
  const input = await waitForSearchInput();
  debugLog("debug", "Omnibox found", { tag: input.tagName, id: input.id, name: input.name });

  input.focus();
  await sleep(80);
  setNativeInputValue(input, keyword);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, data: keyword, inputType: "insertText" }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(250);
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    })
  );
  input.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    })
  );
  await sleep(500);
}

/** Maps place URLs encode the same business under different variants (query params etc.). */
function stablePlaceKeysFromHref(href) {
  const keys = new Set();
  if (!href || typeof href !== "string") return [];
  let dec = href;
  try {
    dec = decodeURIComponent(href);
  } catch (_) {}
  const ft = dec.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
  if (ft) keys.add("ft:" + ft[1].replace(/\s+/g, "").toLowerCase());

  let m16 = dec.match(/!16s([^!]+)/i);
  if (m16) {
    let g = m16[1].trim();
    try {
      g = decodeURIComponent(g);
    } catch (_) {}
    g = g.replace(/^%2F[gG]%2F/i, "/g/").replace(/^\/g\//i, "/g/");
    const gm = g.match(/\/g\/([^/?&,]+)/i);
    if (gm) keys.add("g:" + gm[1].replace(/[^\w_-]/gi, "").toLowerCase());
    else keys.add("g:" + g.replace(/[^\w_-]/gi, "").toLowerCase().slice(0, 40));
  }

  const cj = dec.match(/!19s(ChIJ[\w\-+/=]+)/i);
  if (cj) keys.add("cj:" + cj[1]);
  try {
    const noHash = href.split("#")[0];
    const u = new URL(noHash);
    const pid = u.searchParams.get("place_id") || u.searchParams.get("query_place_id") || "";
    if (pid) keys.add("pid:" + pid);
    const afterPlace = `${u.pathname}`.split("/place/");
    if (afterPlace[1]) keys.add("path:" + afterPlace[1].replace(/\/$/, "").toLowerCase().slice(0, 200));
  } catch (_) {}
  const list = [...keys].filter(Boolean);
  if (!list.length) {
    try {
      const base = href.split("?")[0];
      if (base.length > 20) list.push("raw:" + base.slice(-200).toLowerCase());
    } catch (_) {}
  }
  return list;
}

function phoneDigits(key) {
  const d = normalizeText(key).replace(/\D/g, "");
  return d;
}

function dedupeKeysForRow(href, detail) {
  const keys = new Set(stablePlaceKeysFromHref(href));
  const d = phoneDigits(detail.phone || "");
  if (d.length >= 10) keys.add("ph:" + d);
  else if (d.length >= 7) keys.add("ph:" + d);
  const host = extractHost(detail.website_url);
  if (host) keys.add("wh:" + host);
  return keys;
}

function extractHost(url) {
  try {
    return new URL(String(url).trim()).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function stripInternalLeadFields(row) {
  if (!row || typeof row !== "object") return row;
  const { _dupKeys, ...rest } = row;
  return rest;
}

function inferredKeysFromStoredRow(row) {
  const s = new Set();
  const d = phoneDigits(row.phone || "");
  if (d.length >= 10) s.add("ph:" + d);
  else if (d.length >= 7) s.add("ph:" + d);
  const h = extractHost(row.website_url || "");
  if (h) s.add("wh:" + h);
  return s;
}

function rowKeySet(r) {
  const out = new Set();
  if (!r) return out;
  [...(r._dupKeys instanceof Set ? r._dupKeys : r._dupKeys || [])].forEach((k) => out.add(k));
  [...inferredKeysFromStoredRow(r)].forEach((k) => out.add(k));
  return out;
}

function findDuplicateLeadIndex(leadsArr, candidateKeys) {
  const cand = [...candidateKeys];
  if (!cand.length) return -1;
  for (let i = leadsArr.length - 1; i >= 0; i--) {
    const r = leadsArr[i];
    const rk = rowKeySet(r);
    for (const c of cand) {
      if (c && rk.has(c)) return i;
    }
  }
  return -1;
}

function normalizeHrefNoQuery(href) {
  if (!href) return "";
  return href.replace(/[&#].*$/, "").split("?")[0].trim().toLowerCase();
}

function mergeFieldsInto(existing, detail, keyword, extraKeySet) {
  if (keyword && !existing.search_query) existing.search_query = keyword;
  const incoming = detail;
  const pick = (f) => {
    const a = normalizeText(existing[f]);
    const b = normalizeText(incoming[f]);
    if (!b) return;
    if (!a) {
      existing[f] = incoming[f];
      return;
    }
    if (f === "phone") {
      if (phoneDigits(b).length > phoneDigits(a) || (String(b).includes("+") && !String(a).includes("+")))
        existing[f] = incoming[f];
      return;
    }
    if (f === "title" || f === "address" || f === "website_url") {
      if (b.length > a.length) existing[f] = incoming[f];
    }
  };
  ["title", "address", "phone", "website_url"].forEach(pick);
  if (!(existing._dupKeys instanceof Set)) existing._dupKeys = new Set(existing._dupKeys || []);
  [...(extraKeySet instanceof Set ? extraKeySet : [])].forEach((k) => existing._dupKeys.add(k));
}

async function scrapeOneKeyword(keyword, opts) {
  const { limit, getAll } = opts;
  await runSearch(keyword);
  debugLog("debug", "Waiting for results feed after search…");
  await sleep(2000);

  const feed = await waitForFeed();
  debugLog("info", "Results feed attached", { scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight });

  /** Dedupe clicks in this feed sweep (URLs can mutate between scroll passes). */
  const seenHrefOrLabel = new Set();
  /** Strong keys from title+phone+g+ft — blocks true duplicates Maps re-injects while scrolling */
  const globalPlaceKeysSeen = new Set();

  const rows = [];
  let stagnant = 0;
  let pass = 0;

  while (true) {
    pass += 1;
    if (await isStopped()) {
      debugLog("warn", "Stop flag detected — exiting keyword loop.", { keyword, pass });
      break;
    }

    if (listEndVisible()) {
      debugLog("info", "End-of-list marker visible.", { keyword });
      break;
    }

    const articles = [...feed.querySelectorAll('div[role="article"]')];
    debugLog("debug", `Pass ${pass}: scanning listing cards`, {
      articlesInDom: articles.length,
      collected: rows.length,
    });

    for (const art of articles) {
      if (await isStopped()) break;

      const link = art.querySelector("a.hfpxzc");
      const href = link?.href || "";
      if (!href) continue;
      const hrefCanon = normalizeHrefNoQuery(href);
      if (hrefCanon && seenHrefOrLabel.has(hrefCanon)) {
        debugLog("debug", "Skip duplicate card URL already opened this run", hrefCanon.slice(0, 100));
        continue;
      }

      const preStable = stablePlaceKeysFromHref(href);
      if (preStable.length && preStable.some((k) => globalPlaceKeysSeen.has(k))) {
        debugLog("debug", "Skip listing — same Maps place keys already scraped this keyword", {
          keys: preStable.slice(0, 3),
        });
        if (hrefCanon) seenHrefOrLabel.add(hrefCanon);
        continue;
      }

      if (hrefCanon) seenHrefOrLabel.add(hrefCanon);

      debugLog("debug", "Opening listing", { key: href.slice(0, 120) });
      link.click();
      await waitForDetailPane();
      await sleep(450);

      let detail = scrapeDetailPanel();
      for (
        let attempt = 0;
        attempt < 5 && (!detail.phone || !detail.address || !detail.website_url);
        attempt++
      ) {
        await sleep(450);
        detail = scrapeDetailPanel();
      }
      debugLog("debug", "Parsed side panel", {
        title: detail.title?.slice(0, 80),
        hasPhone: !!detail.phone,
        hasAddress: !!detail.address,
        hasWebsite: !!detail.website_url,
      });

      const ks = dedupeKeysForRow(href, detail);
      const dupS = findDuplicateLeadIndex(sessionLeads, ks);
      const dupR = findDuplicateLeadIndex(rows, ks);

      if (dupS >= 0 || dupR >= 0) {
        const tgt = dupS >= 0 ? sessionLeads[dupS] : rows[dupR];
        mergeFieldsInto(tgt, detail, keyword, ks);
        [...ks].forEach((k) => globalPlaceKeysSeen.add(k));
        const sessIdx = sessionLeads.indexOf(tgt);
        postToPanel({
          type: "LEADS_ROW_UPDATE",
          index: sessIdx >= 0 ? sessIdx : dupS,
          count: sessionLeads.length,
          row: stripInternalLeadFields(tgt),
        });
        debugLog("debug", "Merged duplicate lead", { sessionIdx: sessIdx, keys: [...ks].slice(0, 4) });
      } else {
        const row = {
          search_query: keyword,
          title: detail.title,
          address: detail.address,
          phone: detail.phone,
          website_url: detail.website_url,
          _dupKeys: ks,
        };
        rows.push(row);
        sessionLeads.push(row);
        [...ks].forEach((k) => globalPlaceKeysSeen.add(k));
        postToPanel({
          type: "LEADS_UPDATE",
          count: sessionLeads.length,
          sessionIndex: sessionLeads.length - 1,
          row: stripInternalLeadFields(row),
        });
      }

      if (!getAll && limit && rows.length >= limit) {
        debugLog("info", `Reached max contacts (${limit}) for keyword.`, { keyword });
        return rows;
      }
    }

    if (await isStopped()) break;

    const beforeScrollTotal = feed.querySelectorAll('div[role="article"]').length;
    const prevTop = feed.scrollTop;
    feed.scrollTop += feed.clientHeight;
    const scrollDelay = 3000 + Math.random() * 1000;
    debugLog("debug", "Scrolling feed", {
      beforeScrollTotal,
      scrollTop: { from: prevTop, to: feed.scrollTop },
      waitMs: Math.round(scrollDelay),
    });
    await sleep(scrollDelay);

    if (listEndVisible()) {
      debugLog("info", "End-of-list after scroll.", { keyword });
      break;
    }

    const afterScrollTotal = feed.querySelectorAll('div[role="article"]').length;
    if (afterScrollTotal <= beforeScrollTotal) stagnant += 1;
    else stagnant = 0;

    debugLog("debug", "Post-scroll DOM snapshot", {
      afterScrollTotal,
      stagnantStreak: stagnant,
    });

    if (stagnant >= 4) {
      debugLog("warn", "No growth after repeated scrolls — assuming end of results.", { keyword });
      break;
    }
  }

  debugLog("info", `Keyword complete`, { keyword, rows: rows.length });
  return rows;
}

async function runBatch(payload) {
  const { keywords, limit, getAll } = payload;
  await chrome.runtime.sendMessage({ action: "CLEAR_STOP" });

  sessionLeads = [];
  postToPanel({ type: "LEADS_RESET" });

  debugLog("info", "Batch configuration", {
    keywords: keywords.length,
    getAll,
    limit: getAll ? null : limit,
  });

  try {
    for (let i = 0; i < keywords.length; i++) {
      if (await isStopped()) {
        debugLog("warn", "Stopped before keyword.", { index: i });
        break;
      }
      const kw = keywords[i];
      debugLog("info", `Starting keyword ${i + 1}/${keywords.length}`, kw);

      let rows = [];
      try {
        rows = await scrapeOneKeyword(kw, { limit, getAll });
      } catch (e) {
        debugLog("error", `Keyword failed: ${e?.message || e}`, { keyword: kw });
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: "KEYWORD_DONE", keyword: kw, rows: [] }, () => resolve());
        });
        continue;
      }

      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: "KEYWORD_DONE", keyword: kw, rows: rows.map(stripInternalLeadFields) },
          () => resolve()
        );
      });

      if (rows.length) {
        debugLog("info", `CSV queued for download`, { keyword: kw, rows: rows.length });
      } else {
        debugLog("warn", `No rows collected — CSV skipped`, { keyword: kw });
      }
    }
    postToPanel({ type: "BATCH_DONE", ok: true });
  } catch (e) {
    debugLog("error", `Batch crashed: ${e?.message || e}`);
    postToPanel({ type: "BATCH_DONE", ok: false, error: String(e?.message || e) });
  }
}

function applyHostWidth(minimized) {
  if (!hostEl) return;
  hostEl.style.width = minimized ? "36px" : "432px";
}

async function loadSidebarPrefs() {
  const v = await chrome.storage.local.get([STORAGE_VISIBLE, STORAGE_MIN, STORAGE_VERBOSE]);
  return {
    visible: v[STORAGE_VISIBLE] !== false,
    minimized: !!v[STORAGE_MIN],
    verbose: v[STORAGE_VERBOSE] !== false,
  };
}

async function mountSidebar() {
  document.querySelectorAll("#" + HOST_ID).forEach((node, idx) => {
    if (idx > 0) node.remove();
  });

  const existing = document.getElementById(HOST_ID);
  if (existing) {
    hostEl = existing;
    iframeEl = existing.querySelector("iframe");
    const prefs = await loadSidebarPrefs();
    if (!prefs.visible) hostEl.style.display = "none";
    applyHostWidth(prefs.minimized);
    postToPanel({
      type: "INIT_STATE",
      minimized: prefs.minimized,
      verbose: prefs.verbose,
      mapsPageOrigin: window.location.origin,
    });
    return;
  }

  const prefs = await loadSidebarPrefs();

  hostEl = document.createElement("div");
  hostEl.id = HOST_ID;
  Object.assign(hostEl.style, {
    position: "fixed",
    top: "0",
    right: "0",
    height: "100vh",
    width: prefs.minimized ? "36px" : "432px",
    zIndex: "2147483646",
    boxSizing: "border-box",
    transition: "width 0.2s ease",
    fontFamily: "system-ui, sans-serif",
    boxShadow: "-12px 0 40px rgba(1, 4, 9, 0.42)",
  });

  iframeEl = document.createElement("iframe");
  iframeEl.src = chrome.runtime.getURL("panel.html");
  Object.assign(iframeEl.style, {
    width: "100%",
    height: "100%",
    border: "none",
    background: "transparent",
  });
  iframeEl.setAttribute("title", "Maps Lead Scraper");

  hostEl.appendChild(iframeEl);
  document.documentElement.appendChild(hostEl);

  if (!prefs.visible) {
    hostEl.style.display = "none";
  }
}

function toggleHostVisibility() {
  if (!hostEl) return;
  const currentlyHidden = hostEl.style.display === "none";
  hostEl.style.display = currentlyHidden ? "block" : "none";
  const nowVisible = hostEl.style.display !== "none";
  chrome.storage.local.set({ [STORAGE_VISIBLE]: nowVisible });
  postToPanel({
    type: "LOG",
    level: "info",
    message: nowVisible ? "Sidebar shown (toolbar icon)." : "Sidebar hidden (toolbar icon).",
    ts: Date.now(),
  });
}

function installUiBridge() {
  if (globalThis.__gmsUiBridgeInstalled) return;
  globalThis.__gmsUiBridgeInstalled = true;

  window.addEventListener(
    "message",
    (event) => {
    if (event.origin !== extOrigin()) return;
    const d = event.data;
    if (!d || typeof d !== "object") return;

    if (d.type === "PANEL_READY") {
      loadSidebarPrefs().then((p) => {
        postToPanel({
          type: "INIT_STATE",
          minimized: p.minimized,
          verbose: p.verbose,
          mapsPageOrigin: window.location.origin,
        });
        applyHostWidth(p.minimized);
      });
      return;
    }

    if (d.type === "PANEL_STATE") {
      const minimized = !!d.minimized;
      chrome.storage.local.set({ [STORAGE_MIN]: minimized });
      applyHostWidth(minimized);
      return;
    }

    if (d.type === "VERBOSE") {
      chrome.storage.local.set({ [STORAGE_VERBOSE]: !!d.value });
      return;
    }

    if (d.type === "STOP") {
      chrome.runtime.sendMessage({ action: "REQUEST_STOP" });
      return;
    }

    if (d.type === "EXPORT_SESSION_CSV") {
      chrome.runtime.sendMessage(
        {
          action: "DOWNLOAD_SESSION_CSV",
          rows: sessionLeads.map(stripInternalLeadFields),
          filename: d.filename || "maps_session_leads",
        },
        (res) => {
          const err = chrome.runtime.lastError;
          if (err) {
            postToPanel({
              type: "LOG",
              level: "error",
              message: err.message || "CSV export failed.",
              ts: Date.now(),
            });
            return;
          }
          if (res?.ok) {
            postToPanel({
              type: "LOG",
              level: "info",
              message: `Downloaded session CSV (${sessionLeads.length} rows).`,
              ts: Date.now(),
            });
          } else {
            postToPanel({
              type: "LOG",
              level: "error",
              message:
                res?.error === "empty"
                  ? `Nothing to export (${sessionLeads.length} rows in session). Start a run and collect at least one listing.`
                  : `CSV failed: ${res?.error || "unknown"}`,
              ts: Date.now(),
            });
          }
        }
      );
      return;
    }

    if (d.type === "CLEAR_SESSION_LEADS") {
      sessionLeads = [];
      postToPanel({ type: "LEADS_RESET" });
      postToPanel({
        type: "LOG",
        level: "info",
        message: "Session table cleared (memory only).",
        ts: Date.now(),
      });
      return;
    }

    if (d.type === "RUN_BATCH") {
      if (batchRunning) {
        postToPanel({
          type: "LOG",
          level: "warn",
          message: "A batch is already running.",
          ts: Date.now(),
        });
        postToPanel({ type: "BATCH_DONE", ok: false, error: "already_running" });
        return;
      }
      batchRunning = true;
      Promise.resolve()
        .then(() => runBatch(d.payload || {}))
        .finally(() => {
          batchRunning = false;
        });
      return;
    }
    },
    false
  );

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "TOGGLE_HOST_VISIBILITY") {
      toggleHostVisibility();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
}

installUiBridge();
mountSidebar();
