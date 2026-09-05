const HOST_ID = "gms-scraper-dock";
const STORAGE_VISIBLE = "gms_host_visible";
const STORAGE_MIN = "gms_minimized";
const STORAGE_VERBOSE = "gms_verbose";

/**
 * Chunked waits that the service-worker PING can unstick.
 * Background/minimized Maps tabs get timer clamping; a ping re-arms overdue sleeps
 * so the scrape loop keeps advancing instead of sitting on a 30–60s clamp.
 */
const sleepHandles = new Set();

function sleep(ms) {
  const end = Date.now() + Math.max(0, ms);
  return new Promise((resolve) => {
    const handle = { end, timer: 0, done: false };
    const finish = () => {
      if (handle.done) return;
      handle.done = true;
      clearTimeout(handle.timer);
      sleepHandles.delete(handle);
      resolve();
    };
    const arm = () => {
      if (handle.done) return;
      const left = handle.end - Date.now();
      if (left <= 0) {
        finish();
        return;
      }
      const slice = Math.min(document.hidden ? 350 : 800, left);
      handle.timer = setTimeout(arm, slice);
    };
    handle.finish = finish;
    handle.arm = arm;
    sleepHandles.add(handle);
    arm();
  });
}

function nudgeSleeps() {
  const now = Date.now();
  for (const handle of [...sleepHandles]) {
    if (handle.done) continue;
    if (now >= handle.end) {
      handle.finish();
      continue;
    }
    clearTimeout(handle.timer);
    handle.arm();
  }
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

const BATCH_RESUME_PREFIX = "gms_batch_resume_v1_";
const BATCH_QUEUE_PREFIX = "gms_batch_v1_";
const DEFAULT_REFRESH_EVERY = 3;
const FREEZE_MS = 120000;
const RESUME_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let batchPhase = "idle";
let lastProgressAt = 0;
let freezeWatchTimer = null;
let plannedReload = false;
let currentKeywordIndex = 0;
let batchOpts = null;
let completedSinceRefresh = 0;
let refreshEveryN = DEFAULT_REFRESH_EVERY;
let resumeKickoffStarted = false;
let myTabId = 0;
let tabKeepAliveAudio = null;

function batchQueueKey(tabId) {
  return BATCH_QUEUE_PREFIX + String(tabId || myTabId || "0");
}

function resumeKey(tabId) {
  return BATCH_RESUME_PREFIX + String(tabId || myTabId || "0");
}

function getMyTabId() {
  return new Promise((resolve) => {
    if (myTabId) {
      resolve(myTabId);
      return;
    }
    chrome.runtime.sendMessage({ action: "GET_TAB_ID" }, (res) => {
      myTabId = Number(res?.tabId) || 0;
      resolve(myTabId);
    });
  });
}

function startTabKeepAliveAudio() {
  if (tabKeepAliveAudio) {
    try {
      tabKeepAliveAudio.ctx?.resume?.();
    } catch (_) {}
    return;
  }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.00008;
    osc.frequency.value = 27.5;
    osc.type = "sine";
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    ctx.resume?.();
    tabKeepAliveAudio = { ctx, osc };
  } catch (_) {}
}

function stopTabKeepAliveAudio() {
  try {
    tabKeepAliveAudio?.osc?.stop();
    tabKeepAliveAudio?.ctx?.close();
  } catch (_) {}
  tabKeepAliveAudio = null;
}

function checkFreezeFromWatchdog() {
  if (plannedReload || batchPhase !== "scraping") return;
  if (!lastProgressAt || Date.now() - lastProgressAt < FREEZE_MS) return;
  debugLog("warn", "Maps looks frozen (no new listings for 2 minutes) — saving leads and refreshing…");
  requestMapsRefresh("freeze", { retryCurrent: true }).catch(() => {});
}

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

async function waitForDetailPane(timeoutMs = 12000) {
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

/** Re-acquire the feed element fresh from the live DOM (never reuse stale refs). */
function queryFeedNow() {
  return document.querySelector('div[role="feed"]');
}

/** After scraping a detail panel, ensure we are back on the results feed. */
async function returnToFeed(maxWait = 10000) {
  let feed = queryFeedNow();
  if (feed && feed.isConnected && feed.querySelectorAll('div[role="article"]').length > 0) {
    return feed;
  }
  const backBtn =
    document.querySelector('button[aria-label="Back"]') ||
    document.querySelector('button[jsaction*="back"]');
  if (backBtn) {
    debugLog("debug", "Clicking back button to return to feed");
    backBtn.click();
    await sleep(600);
  } else {
    document.activeElement?.dispatchEvent?.(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true })
    );
    await sleep(400);
  }
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    feed = queryFeedNow();
    if (feed && feed.isConnected && feed.querySelectorAll('div[role="article"]').length > 0) {
      await sleep(300);
      return feed;
    }
    await sleep(300);
  }
  debugLog("warn", "returnToFeed: timed out waiting for feed to reappear");
  return queryFeedNow();
}

/** Wait for the results feed to actually refresh after a new search (detects stale feed). */
async function waitForFeedRefresh(timeoutMs = 18000) {
  const oldHrefs = new Set();
  const oldFeed = queryFeedNow();
  if (oldFeed) {
    oldFeed.querySelectorAll('div[role="article"] a.hfpxzc').forEach((a) => {
      if (a.href) oldHrefs.add(a.href.split("?")[0]);
    });
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const feed = queryFeedNow();
    if (!feed) { await sleep(400); continue; }
    // Feed must not still show the old end-of-list marker
    if (listEndVisible()) { await sleep(500); continue; }
    const links = feed.querySelectorAll('div[role="article"] a.hfpxzc');
    if (links.length > 0) {
      let hasNew = false;
      for (const a of links) {
        const k = (a.href || "").split("?")[0];
        if (k && !oldHrefs.has(k)) { hasNew = true; break; }
      }
      if (hasNew || oldHrefs.size === 0) return feed;
    }
    await sleep(500);
  }
  return queryFeedNow() || (await waitForFeed());
}

function listEndVisible() {
  const feed = queryFeedNow();
  if (feed) {
    const endDivs = feed.querySelectorAll(".HlvSq, .m6QErb.XiKgde, .m6QErb.XiKgde.tLjsW, .m6QErb.XiKgde.tLjsW.X39k4d");
    for (const div of endDivs) {
      const text = div.textContent || "";
      if (/you.?ve reached the end|end of the list/i.test(text)) {
        const rect = div.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0) return true;
      }
    }
    const pb = feed.querySelectorAll(".PbZDve .fontBodyMedium, .PbZDve p, .PbZDve span");
    for (const el of pb) {
      if (/you.?ve reached the end|end of the list/i.test(el.textContent || "")) {
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0) return true;
      }
    }
  }

  const end = document.querySelector(".HlvSq");
  if (end && /end of the list|you.?ve reached the end/i.test(end.textContent || "")) {
    const rect = end.getBoundingClientRect();
    if (rect.height > 0 && rect.width > 0) return true;
  }
  return false;
}

function countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen) {
  if (!feed) return 0;
  let n = 0;
  for (const a of feed.querySelectorAll('div[role="article"] a.hfpxzc')) {
    const href = a.href || "";
    if (!href || processedHrefs.has(href)) continue;
    const hrefCanon = normalizeHrefNoQuery(href);
    if (hrefCanon && seenHrefOrLabel.has(hrefCanon)) continue;
    const preStable = stablePlaceKeysFromHref(href);
    if (preStable.length && preStable.some((k) => globalPlaceKeysSeen.has(k))) continue;
    n += 1;
  }
  return n;
}

function feedScrollAtBottom(feed, slackPx = 12) {
  const { scroller, scrollTop, scrollHeight, clientHeight } = scrollMetrics(feed);
  if (!scroller) return false;
  return scrollTop + clientHeight >= scrollHeight - slackPx;
}

function isScrollableEl(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  try {
    const oy = window.getComputedStyle(el).overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
    return el.scrollHeight > el.clientHeight + 4;
  } catch (_) {
    return false;
  }
}

/** Maps usually scrolls a parent/inner pane — setting scrollTop on `role=feed` alone does nothing. */
function findFeedScroller(feed) {
  if (!feed) return null;
  let best = null;
  let bestDelta = 0;
  const consider = (el) => {
    if (!isScrollableEl(el)) return;
    const d = el.scrollHeight - el.clientHeight;
    if (d > bestDelta) {
      bestDelta = d;
      best = el;
    }
  };
  consider(feed);
  let p = feed.parentElement;
  for (let i = 0; i < 10 && p; i++) {
    consider(p);
    p = p.parentElement;
  }
  try {
    feed.querySelectorAll("div").forEach((div) => consider(div));
  } catch (_) {}
  return best || feed;
}

function scrollMetrics(feed) {
  const scroller = findFeedScroller(feed);
  if (!scroller) return { scroller: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
  return {
    scroller,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  };
}

async function scrollFeedToTop(feed) {
  feed = queryFeedNow() || feed;
  if (!feed) return;
  const { scroller } = scrollMetrics(feed);
  scroller.scrollTop = 0;
  const first = feed.querySelector('div[role="article"]');
  if (first) {
    try {
      first.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
    } catch (_) {
      try {
        first.scrollIntoView(true);
      } catch (_) {}
    }
  }
  await sleep(400);
}

async function restoreFeedScroll(feed, scrollBefore) {
  feed = queryFeedNow() || feed;
  if (!feed) return;
  const { scroller } = scrollMetrics(feed);
  scroller.scrollTop = scrollBefore;
  await sleep(250);
}

/** Scroll the results list down using methods Maps actually responds to. Returns whether scrollTop changed. */
async function scrollFeedDown(feed, processedHrefs) {
  feed = queryFeedNow() || feed;
  if (!feed) return { moved: false, method: "none" };

  const { scroller } = scrollMetrics(feed);
  const before = scroller.scrollTop;
  const step = Math.max(Math.floor(scroller.clientHeight * 0.85), 420);
  const movedEnough = () => scroller.scrollTop > before + 3;

  try {
    const r = scroller.getBoundingClientRect?.();
    if (r && r.width > 8 && r.height > 8) {
      const cx = r.left + Math.min(40, r.width / 2);
      const cy = r.top + Math.min(80, r.height / 2);
      for (const type of ["mousedown", "mouseup", "click"]) {
        scroller.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window })
        );
      }
      await sleep(80);
    }
  } catch (_) {}

  const articles = [...feed.querySelectorAll('div[role="article"]')];
  let target = null;
  for (let i = articles.length - 1; i >= 0; i--) {
    const h = articles[i].querySelector("a.hfpxzc")?.href || "";
    if (h && !processedHrefs.has(h)) {
      target = articles[i];
      break;
    }
  }
  if (!target && articles.length) target = articles[articles.length - 1];

  if (target) {
    try {
      target.scrollIntoView({ block: "end", inline: "nearest", behavior: "instant" });
    } catch (_) {
      try {
        target.scrollIntoView(false);
      } catch (_) {}
    }
    await sleep(150);
    if (movedEnough()) {
      return { moved: true, method: "scrollIntoView", scroller, before, after: scroller.scrollTop, step };
    }
  }

  try {
    scroller.focus?.({ preventScroll: true });
  } catch (_) {
    try {
      scroller.focus?.();
    } catch (_) {}
  }

  try {
    scroller.scrollBy({ top: step, left: 0, behavior: "instant" });
  } catch (_) {
    scroller.scrollTop = before + step;
  }
  await sleep(120);
  if (movedEnough()) {
    return { moved: true, method: "scrollBy", scroller, before, after: scroller.scrollTop, step };
  }

  scroller.scrollTop = Math.min(before + step, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  await sleep(100);
  if (movedEnough()) {
    return { moved: true, method: "scrollTop", scroller, before, after: scroller.scrollTop, step };
  }

  try {
    scroller.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: step,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
    feed.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: step,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        view: window,
      })
    );
  } catch (_) {}
  await sleep(150);
  if (movedEnough()) {
    return { moved: true, method: "wheel", scroller, before, after: scroller.scrollTop, step };
  }

  try {
    scroller.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", code: "PageDown", keyCode: 34, bubbles: true })
    );
  } catch (_) {}
  await sleep(150);

  return {
    moved: movedEnough(),
    method: movedEnough() ? "pageDown" : "failed",
    scroller,
    before,
    after: scroller.scrollTop,
    step,
  };
}

/**
 * Scroll the results list down many times in a row — Maps lazy-loads after several scrolls,
 * not after a single scrollTop bump.
 */
async function burstScrollFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen, opts = {}) {
  const maxSteps = opts.maxSteps ?? 18;
  const pauseMs = opts.pauseMs ?? 500;

  feed = queryFeedNow() || feed;
  if (!feed) return { kind: "lost", steps: 0 };

  const sm0 = scrollMetrics(feed);
  const startTop = sm0.scrollTop;
  const startArticles = feed.querySelectorAll('div[role="article"]').length;
  const startPending = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
  let steps = 0;
  let anyMoved = false;
  let lastMethod = "none";

  for (let i = 0; i < maxSteps; i++) {
    if (await isStopped()) return { kind: "stopped", steps, anyMoved };

    feed = queryFeedNow() || feed;
    if (!feed) return { kind: "lost", steps, anyMoved };

    const pending = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
    const articles = feed.querySelectorAll('div[role="article"]').length;

    if (listEndVisible() && pending === 0) {
      return { kind: "end", steps, anyMoved, pending: 0 };
    }

    // New cards appeared in the feed — stop bursting and scrape them first
    if (i > 0 && (pending > startPending || articles > startArticles + 1)) {
      return { kind: "listings", steps, anyMoved, pending, articles };
    }

    const one = await scrollFeedDown(feed, processedHrefs);
    steps += 1;
    if (one.moved) anyMoved = true;
    lastMethod = one.method;

    await sleep(pauseMs);

    feed = queryFeedNow() || feed;
    if (!feed) return { kind: "lost", steps, anyMoved };

    const pendingAfter = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
    if (pendingAfter > startPending) {
      return { kind: "listings", steps, anyMoved, pending: pendingAfter };
    }

    if (listEndVisible()) {
      return { kind: "end", steps, anyMoved, pending: pendingAfter };
    }

    // Near bottom: pause longer so Maps can inject more rows or the end marker
    if (feedScrollAtBottom(feed)) {
      for (let w = 0; w < 8; w++) {
        await sleep(650);
        feed = queryFeedNow() || feed;
        if (!feed) break;
        const p = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
        if (p > startPending) return { kind: "listings", steps, anyMoved, pending: p };
        if (listEndVisible() && p === 0) return { kind: "end", steps, anyMoved, pending: 0 };
        const sh = scrollMetrics(feed).scrollHeight;
        if (sh > sm0.scrollHeight + 30) break;
      }
      if (feedScrollAtBottom(feed) && !listEndVisible()) {
        await scrollFeedToBottom(feed);
        await sleep(700);
      }
    }
  }

  feed = queryFeedNow() || feed;
  const endTop = scrollMetrics(feed).scrollTop;
  const pending = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);

  if (listEndVisible() && pending === 0) return { kind: "end", steps, anyMoved, pending: 0 };
  if (pending > startPending) return { kind: "listings", steps, anyMoved, pending };
  if (anyMoved || endTop > startTop + 20) {
    return { kind: "scrolled", steps, anyMoved, lastMethod, deltaTop: endTop - startTop, pending };
  }
  return { kind: "failed", steps, anyMoved, lastMethod, pending };
}

async function scrollFeedToBottom(feed) {
  feed = queryFeedNow() || feed;
  if (!feed) return;
  const { scroller } = scrollMetrics(feed);
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const articles = feed.querySelectorAll('div[role="article"]');
  const last = articles[articles.length - 1];
  if (last) {
    try {
      last.scrollIntoView({ block: "end", behavior: "instant" });
    } catch (_) {
      try {
        last.scrollIntoView(false);
      } catch (_) {}
    }
  }
  await sleep(400);
}

/** After a scroll, wait patiently for lazy-loaded cards or the end-of-list marker. */
async function waitForListingsOrEnd(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen, maxWaitMs = 30000) {
  const start = Date.now();
  let lastHeight = scrollMetrics(feed).scrollHeight;
  while (Date.now() - start < maxWaitMs) {
    if (await isStopped()) return { kind: "stopped" };
    feed = queryFeedNow() || feed;
    if (!feed) return { kind: "lost" };

    const pending = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
    if (pending > 0) return { kind: "listings", pending };

    if (listEndVisible() && pending === 0) return { kind: "end" };

    const sh = scrollMetrics(feed).scrollHeight;
    if (sh > lastHeight + 20) lastHeight = sh;

    await sleep(500);
  }
  feed = queryFeedNow() || feed;
  const pending = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
  if (pending > 0) return { kind: "listings", pending };
  if (listEndVisible() && pending === 0) return { kind: "end" };
  return { kind: "timeout", pending };
}

async function confirmEndOfList(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen) {
  for (let i = 0; i < 3; i++) {
    await sleep(700);
    feed = queryFeedNow() || feed;
    const pending = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
    if (!listEndVisible() || pending > 0) return false;
  }
  return true;
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

function serializeLeads(leads) {
  return (leads || []).map((r) => ({
    search_query: r.search_query || "",
    title: r.title || "",
    address: r.address || "",
    phone: r.phone || "",
    website_url: r.website_url || "",
    email: r.email || "",
    _dupKeys: r._dupKeys instanceof Set ? [...r._dupKeys] : Array.isArray(r._dupKeys) ? r._dupKeys : [],
  }));
}

function hydrateLead(raw) {
  const keys = raw && raw._dupKeys;
  return {
    search_query: (raw && raw.search_query) || "",
    title: (raw && raw.title) || "",
    address: (raw && raw.address) || "",
    phone: (raw && raw.phone) || "",
    website_url: (raw && raw.website_url) || "",
    email: (raw && raw.email) || "",
    _dupKeys: new Set(Array.isArray(keys) ? keys : []),
  };
}

function storageSet(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (r) => resolve(r || {}));
  });
}

function storageRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

function markProgress() {
  lastProgressAt = Date.now();
}

function stopFreezeWatch() {
  if (freezeWatchTimer) {
    clearInterval(freezeWatchTimer);
    freezeWatchTimer = null;
  }
}

function startFreezeWatch() {
  stopFreezeWatch();
  freezeWatchTimer = setInterval(() => checkFreezeFromWatchdog(), 15000);
}

async function persistCheckpoint(extra = {}) {
  if (!batchOpts) return;
  const pack = {
    keywords: batchOpts.keywords,
    limit: batchOpts.limit,
    getAll: !!batchOpts.getAll,
    autoEnrich: !!batchOpts.autoEnrich,
    combineBatchCsv: !!batchOpts.combineBatchCsv,
    mapsRefreshEvery: refreshEveryN,
    nextIndex: currentKeywordIndex,
    sessionLeads: serializeLeads(sessionLeads),
    refreshEveryN,
    savedAt: Date.now(),
    pending: false,
    ...extra,
  };
  try {
    await getMyTabId();
    await storageSet({ [resumeKey()]: pack });
  } catch (e) {
    debugLog("warn", "Could not checkpoint leads to storage.", String(e?.message || e));
  }
}

async function clearResumePack() {
  try {
    await getMyTabId();
    await storageRemove(resumeKey());
  } catch (_) {}
}

async function requestMapsRefresh(reason, { retryCurrent } = {}) {
  if (plannedReload) return;
  plannedReload = true;
  stopFreezeWatch();
  const nextIndex = retryCurrent ? currentKeywordIndex : currentKeywordIndex + 1;
  debugLog("info", `Saving ${sessionLeads.length} lead(s) and refreshing Maps (${reason}). Will continue at search ${nextIndex + 1}.`);
  await persistCheckpoint({ nextIndex, pending: true, reason: String(reason || "refresh") });
  await sleep(400);
  window.location.href = "https://www.google.com/maps";
}

function replaySessionLeadsToPanel() {
  postToPanel({ type: "LEADS_RESET" });
  sessionLeads.forEach((row, i) => {
    postToPanel({
      type: "LEADS_UPDATE",
      count: sessionLeads.length,
      sessionIndex: i,
      row: stripInternalLeadFields(row),
    });
  });
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
  debugLog("debug", "Waiting for fresh results feed after search…");
  await sleep(2500);

  let feed = await waitForFeedRefresh();
  if (!feed) feed = await waitForFeed();
  debugLog("info", "Results feed attached", { scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight });

  // CRITICAL: If end-of-list marker is still visible from previous keyword, wait for it to clear
  if (listEndVisible()) {
    debugLog("warn", "Stale end-of-list marker detected after feed refresh — waiting for it to clear");
    let cleared = false;
    for (let retry = 0; retry < 3 && !cleared; retry++) {
      await sleep(2000);
      if (!listEndVisible()) { cleared = true; break; }
      debugLog("info", `Re-submitting search (attempt ${retry + 1}) to clear stale end-of-list`, keyword);
      await runSearch(keyword);
      await sleep(3000);
      feed = queryFeedNow() || feed;
      if (!listEndVisible()) { cleared = true; break; }
    }
    if (!cleared) {
      debugLog("warn", "Could not clear stale end-of-list marker — proceeding anyway, will ignore it");
    }
    feed = queryFeedNow() || feed;
  }

  /** Dedupe clicks in this feed sweep */
  const seenHrefOrLabel = new Set();
  /** Strong keys from title+phone+g+ft — blocks true duplicates Maps re-injects while scrolling */
  const globalPlaceKeysSeen = new Set();
  /** Tracks which hrefs we've already scraped in this keyword */
  const processedHrefs = new Set();

  const rows = [];
  let idleScrollPasses = 0;

  debugLog("info", "Scrape → scroll → wait loop until “You've reached the end of the list.”");

  // Start at the top of the feed
  feed = queryFeedNow() || feed;
  if (feed) {
    await scrollFeedToTop(feed);
    await sleep(400);
  }

  while (true) {
    if (plannedReload || (await isStopped())) return rows;

    feed = queryFeedNow() || feed;
    if (!feed) {
      debugLog("warn", "Feed lost during scrape");
      break;
    }

    // Get all currently visible articles in DOM order (top to bottom)
    const articles = Array.from(feed.querySelectorAll('div[role="article"]'));

    for (const article of articles) {
      if (plannedReload || (await isStopped())) break;

      const link = article.querySelector('a.hfpxzc');
      if (!link || !link.href) continue;

      const href = link.href;
      if (processedHrefs.has(href)) continue;

      const hrefCanon = normalizeHrefNoQuery(href);
      if (hrefCanon && seenHrefOrLabel.has(hrefCanon)) {
        processedHrefs.add(href);
        continue;
      }

      const preStable = stablePlaceKeysFromHref(href);
      if (preStable.length && preStable.some((k) => globalPlaceKeysSeen.has(k))) {
        if (hrefCanon) seenHrefOrLabel.add(hrefCanon);
        processedHrefs.add(href);
        continue;
      }
      if (hrefCanon) seenHrefOrLabel.add(hrefCanon);

      // Save scroll position so we can resume after returning
      const { scrollTop: scrollBefore } = scrollMetrics(feed);

      debugLog("debug", `Scraping listing ${processedHrefs.size + 1}`, { key: href.slice(0, 100) });
      link.click();
      await waitForDetailPane();
      await sleep(450);

      let detail = scrapeDetailPanel();
      for (let attempt = 0; attempt < 5 && (!detail.phone || !detail.address || !detail.website_url); attempt++) {
        await sleep(450);
        detail = scrapeDetailPanel();
      }

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
      } else {
        const row = {
          search_query: keyword,
          title: detail.title,
          address: detail.address,
          phone: detail.phone,
          website_url: detail.website_url,
          email: "",
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

      processedHrefs.add(href);

      // Return to feed
      const feedCheck = queryFeedNow();
      if (!feedCheck || !feedCheck.isConnected || feedCheck.querySelectorAll('div[role="article"]').length === 0) {
        debugLog("debug", "Feed lost after detail panel — navigating back");
        feed = await returnToFeed() || (await waitForFeed(10000));
      } else {
        feed = feedCheck;
      }

      // Restore scroll position so we continue from where we left off
      if (feed) await restoreFeedScroll(feed, scrollBefore);

      markProgress();
      // Keep-alive ping every 5 listings
      if (processedHrefs.size % 5 === 0) {
        try { chrome.runtime.sendMessage({ action: "KEEPALIVE" }); } catch (_) {}
        persistCheckpoint().catch(() => {});
      }

      if (!getAll && limit && rows.length >= limit) {
        debugLog("info", `Reached max contacts (${limit}) for keyword.`, { keyword });
        return rows;
      }
    }

    // Done only when Maps shows the end marker AND every visible card is processed.
    feed = queryFeedNow() || feed;
    const pendingNow = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
    if (listEndVisible() && pendingNow === 0) {
      if (await confirmEndOfList(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen)) {
        debugLog("info", "End of list confirmed — all listings scraped for this keyword.", {
          totalScraped: processedHrefs.size,
          rows: rows.length,
        });
        break;
      }
    }

    if (!feed) break;

    const smBefore = scrollMetrics(feed);
    const burst = await burstScrollFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen, {
      maxSteps: 20,
      pauseMs: 520,
    });
    feed = queryFeedNow() || feed;

    debugLog("debug", "Burst scroll (multiple steps down the list)", {
      kind: burst.kind,
      steps: burst.steps,
      moved: burst.anyMoved,
      pending: burst.pending ?? pendingNow,
      deltaTop: burst.deltaTop,
      lastMethod: burst.lastMethod,
      scrollTop: smBefore.scrollTop,
      scrollHeight: smBefore.scrollHeight,
    });

    if (burst.kind === "stopped") break;

    if (burst.kind === "end") {
      const stillPending = countUnprocessedInFeed(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen);
      if (stillPending === 0 && (await confirmEndOfList(feed, processedHrefs, seenHrefOrLabel, globalPlaceKeysSeen))) {
        debugLog("info", "End marker after burst scroll — keyword complete.", { totalScraped: processedHrefs.size });
        break;
      }
      idleScrollPasses = 0;
      continue;
    }

    if (burst.kind === "listings" || burst.kind === "scrolled") {
      idleScrollPasses = 0;
      continue;
    }

    // failed / lost — keep trying unless we've been stuck at bottom for a long time
    const atBottom = feedScrollAtBottom(feed);
    if (burst.kind === "failed" && !burst.anyMoved) {
      debugLog("warn", "Burst scroll did not move the list — click the results pane or keep Maps tab focused.", burst);
    }

    if (atBottom && !listEndVisible()) {
      idleScrollPasses += 1;
      debugLog("debug", "Waiting at bottom after burst — Maps may still be loading", {
        idleScrollPasses,
        scrollHeight: scrollMetrics(feed).scrollHeight,
      });
    } else {
      idleScrollPasses = 0;
    }

    if (idleScrollPasses >= 8) {
      debugLog("warn", "No end marker after many burst attempts — moving to next keyword.", {
        totalScraped: processedHrefs.size,
      });
      break;
    }
  }

  debugLog("info", `Keyword complete`, { keyword, rows: rows.length, totalScraped: processedHrefs.size });
  return rows;
}

async function loadBatchFromPayload(payload) {
  if (payload && (payload.fromStoredBatch || payload.fromSession)) {
    const tabId = await getMyTabId();
    const key = payload.batchStorageKey || batchQueueKey(tabId);
    const got = await chrome.storage.local.get(key);
    const pack = got[key];
    await chrome.storage.local.remove(key);
    if (!pack || !Array.isArray(pack.keywords)) {
      throw new Error("Batch queue missing from storage — click Start again.");
    }
    return {
      keywords: pack.keywords,
      limit: pack.limit,
      getAll: !!pack.getAll,
      autoEnrich: !!pack.autoEnrich,
      combineBatchCsv: !!pack.combineBatchCsv,
      mapsRefreshEvery: Number(pack.mapsRefreshEvery) || 0,
    };
  }
  if (payload && payload.fromResume) {
    return {
      keywords: payload.keywords || [],
      limit: payload.limit,
      getAll: !!payload.getAll,
      autoEnrich: !!payload.autoEnrich,
      combineBatchCsv: !!payload.combineBatchCsv,
      mapsRefreshEvery: Number(payload.mapsRefreshEvery) || 0,
      fromResume: true,
      resumeNextIndex: Number(payload.resumeNextIndex) || 0,
    };
  }
  const { keywords, limit, getAll, autoEnrich, combineBatchCsv, mapsRefreshEvery } = payload || {};
  return {
    keywords: keywords || [],
    limit,
    getAll: !!getAll,
    autoEnrich: !!autoEnrich,
    combineBatchCsv: !!combineBatchCsv,
    mapsRefreshEvery: Number(mapsRefreshEvery) || 0,
  };
}

let enrichAutoWait = null;

function waitForAutoEnrich(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (enrichAutoWait === finish) enrichAutoWait = null;
      resolve(result || { ok: false });
    };
    enrichAutoWait = finish;
    const timer = setTimeout(() => finish({ ok: false, timeout: true }), timeoutMs);
    const poll = setInterval(() => {
      isStopped().then((stopped) => {
        if (stopped) finish({ ok: false, stopped: true });
      });
    }, 1000);
  });
}

function packKeywordRowsForEnrich(rows) {
  return rows.map((r) => ({
    search_query: r.search_query || "",
    title: r.title || "",
    address: r.address || "",
    phone: r.phone || "",
    website_url: r.website_url || "",
    sessionIndex: sessionLeads.indexOf(r),
  }));
}

function downloadSessionCsvOnce(filename) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        action: "DOWNLOAD_SESSION_CSV",
        rows: sessionLeads.map(stripInternalLeadFields),
        filename: filename || "maps_combined",
      },
      (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          debugLog("error", err.message || "Combined CSV download failed.");
          resolve({ ok: false, error: err.message });
          return;
        }
        if (res?.ok) {
          debugLog("info", `Combined CSV downloaded (${sessionLeads.length} rows).`);
          resolve({ ok: true });
          return;
        }
        debugLog("warn", `Combined CSV skipped: ${res?.error || "unknown"}`);
        resolve({ ok: false, error: res?.error || "unknown" });
      }
    );
  });
}

async function autoEnrichThenPrepareDownload(rows, keyword, progress) {
  if (!rows.length) return { ok: true, empty: true, stopped: false };
  postToPanel({
    type: "BATCH_PROGRESS",
    current: progress.current,
    total: progress.total,
    keyword,
    leads: sessionLeads.length,
    phase: progress.phase || "enrich",
  });
  debugLog("info", "Auto-enrich before CSV download…", { keyword, rows: rows.length });
  postToPanel({
    type: "ENRICH_AUTO_REQUEST",
    rows: packKeywordRowsForEnrich(rows),
    keyword,
  });
  const timeoutMs = Math.min(30 * 60 * 1000, 90000 + rows.length * 45000);
  const result = await waitForAutoEnrich(timeoutMs);
  if (result.timeout) {
    debugLog("warn", "Auto-enrich timed out — downloading this search as-is, then next query.", { keyword });
  } else if (result.stopped) {
    debugLog("warn", "Stopped during auto-enrich.", { keyword });
  } else if (!result.ok) {
    debugLog("warn", "Auto-enrich did not finish cleanly — downloading this search, then next query.", {
      keyword,
      error: result.error || "",
    });
  } else {
    debugLog("info", "Auto-enrich finished — downloading CSV, then next search.", { keyword });
  }
  return result;
}

async function runBatch(payload) {
  const loaded = await loadBatchFromPayload(payload);
  const { keywords, limit, getAll, autoEnrich, combineBatchCsv, mapsRefreshEvery } = loaded;
  const fromResume = !!loaded.fromResume;
  const startIndex = fromResume ? Math.max(0, loaded.resumeNextIndex || 0) : 0;

  await chrome.runtime.sendMessage({ action: "CLEAR_STOP" });
  if (!fromResume) {
    sessionLeads = [];
    postToPanel({ type: "LEADS_RESET" });
    await clearResumePack();
  }

  batchOpts = { keywords, limit, getAll, autoEnrich, combineBatchCsv };
  refreshEveryN = Number(mapsRefreshEvery) > 0 ? Number(mapsRefreshEvery) : 0;
  completedSinceRefresh = fromResume ? 0 : 0;
  plannedReload = false;
  batchPhase = "scraping";
  markProgress();
  startTabKeepAliveAudio();
  startFreezeWatch();

  // Signal background to start keep-alive alarm (this tab only; other tabs keep running)
  try { await chrome.runtime.sendMessage({ action: "BATCH_STARTED" }); } catch (_) {}

  debugLog("info", "Batch configuration", {
    keywords: keywords.length,
    startIndex: startIndex + 1,
    fromResume,
    getAll,
    limit: getAll ? null : limit,
    autoEnrich,
    combineBatchCsv,
    refreshEvery: refreshEveryN,
    savedLeads: sessionLeads.length,
    tabId: myTabId,
    preview: keywords.slice(0, 5),
  });
  debugLog(
    "info",
    "This queue is locked to this Maps tab. Switch, minimize, or run other Maps tabs in parallel — Stop only stops this tab.",
    { tabId: myTabId, visibility: document.visibilityState }
  );

  if (!keywords.length) {
    debugLog("error", "Batch has no keywords — nothing to run.", {});
    stopFreezeWatch();
    batchPhase = "idle";
    postToPanel({ type: "BATCH_DONE", ok: false, error: "no_keywords" });
    return;
  }

  try {
    for (let i = startIndex; i < keywords.length; i++) {
      currentKeywordIndex = i;
      if (plannedReload) return;
      if (await isStopped()) {
        debugLog("warn", "Stopped before keyword.", { index: i });
        break;
      }
      const kw = keywords[i];
      debugLog("info", `Starting keyword ${i + 1}/${keywords.length}`, kw);
      postToPanel({
        type: "BATCH_PROGRESS",
        current: i + 1,
        total: keywords.length,
        keyword: kw,
        leads: sessionLeads.length,
        phase: "scraping",
      });

      // Inter-keyword delay: let Maps settle after previous keyword finished
      if (i > startIndex) {
        debugLog("debug", "Waiting between keywords for Maps to reset…");
        await sleep(2000);
      }

      let rows = [];
      try {
        batchPhase = "scraping";
        markProgress();
        rows = await scrapeOneKeyword(kw, { limit, getAll });
      } catch (e) {
        if (plannedReload) return;
        debugLog("error", `Keyword failed: ${e?.message || e}`, { keyword: kw });
        if (!combineBatchCsv) {
          await new Promise((resolve) => {
            chrome.runtime.sendMessage({ action: "KEYWORD_DONE", keyword: kw, rows: [] }, () => resolve());
          });
        }
        completedSinceRefresh += 1;
        await persistCheckpoint({ nextIndex: i + 1, pending: false });
        continue;
      }

      if (plannedReload) return;

      let stoppedDuringEnrich = false;
      if (autoEnrich && !combineBatchCsv && rows.length) {
        if (await isStopped()) {
          debugLog("warn", "Stopped before auto-enrich.", { keyword: kw });
        } else {
          batchPhase = "enrich";
          const enrichRes = await autoEnrichThenPrepareDownload(rows, kw, {
            current: i + 1,
            total: keywords.length,
          });
          batchPhase = "scraping";
          markProgress();
          stoppedDuringEnrich = !!enrichRes.stopped;
        }
      }

      if (plannedReload) return;

      if (!combineBatchCsv) {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: "KEYWORD_DONE", keyword: kw, rows: rows.map(stripInternalLeadFields) },
            () => resolve()
          );
        });
        if (rows.length) {
          debugLog("info", `CSV queued for download`, { keyword: kw, rows: rows.length, autoEnrich });
        } else {
          debugLog("warn", `No rows collected — CSV skipped`, { keyword: kw });
        }
      } else {
        debugLog("info", `Combined mode: holding rows until all searches finish`, {
          keyword: kw,
          rows: rows.length,
          session: sessionLeads.length,
        });
      }

      debugLog("info", `Finished keyword ${i + 1}/${keywords.length}`, { keyword: kw, rows: rows.length });
      debugLog("info", `Session total: ${sessionLeads.length} leads. Moving to next keyword…`);

      completedSinceRefresh += 1;
      await persistCheckpoint({ nextIndex: i + 1, pending: false });

      if (stoppedDuringEnrich || (await isStopped())) {
        debugLog("warn", "Stopped after this keyword — not starting the next search.", { index: i });
        break;
      }

      if (refreshEveryN > 0 && completedSinceRefresh >= refreshEveryN && i + 1 < keywords.length) {
        await requestMapsRefresh("every-" + refreshEveryN, { retryCurrent: false });
        return;
      }
    }

    if (plannedReload) return;

    if (combineBatchCsv && sessionLeads.length) {
      if (!(await isStopped())) {
        debugLog("info", "All searches collected — enriching the full table, then one CSV.", {
          rows: sessionLeads.length,
        });
        batchPhase = "enrich";
        await autoEnrichThenPrepareDownload(sessionLeads, "all searches", {
          current: keywords.length,
          total: keywords.length,
          phase: "enrich-all",
        });
        batchPhase = "scraping";
      } else {
        debugLog("warn", "Stopped before combined enrich — downloading collected rows as-is.");
      }
      await downloadSessionCsvOnce("maps_combined");
    }

    if (!plannedReload) {
      postToPanel({ type: "BATCH_DONE", ok: true, combinedCsv: !!combineBatchCsv });
    }
  } catch (e) {
    if (plannedReload) return;
    debugLog("error", `Batch crashed: ${e?.message || e}`);
    postToPanel({ type: "BATCH_DONE", ok: false, error: String(e?.message || e) });
  } finally {
    stopFreezeWatch();
    if (!plannedReload) {
      batchPhase = "idle";
      batchOpts = null;
      stopTabKeepAliveAudio();
      await clearResumePack();
      try { await chrome.runtime.sendMessage({ action: "BATCH_ENDED" }); } catch (_) {}
    }
  }
}

async function tryResumeSavedBatch() {
  if (resumeKickoffStarted || batchRunning) return;
  const tabId = await getMyTabId();
  if (!tabId) return;
  const key = resumeKey(tabId);
  const got = await storageGet(key);
  const pack = got[key];
  if (!pack || !Array.isArray(pack.keywords) || !pack.keywords.length) return;
  if (pack.aborted) return;
  const age = Date.now() - (Number(pack.savedAt) || 0);
  if (age > RESUME_MAX_AGE_MS) {
    await clearResumePack();
    return;
  }
  const nextIndex = Math.max(0, Number(pack.nextIndex) || 0);
  if (nextIndex >= pack.keywords.length) {
    await clearResumePack();
    return;
  }
  if (!pack.pending && age > 30 * 60 * 1000) {
    return;
  }

  resumeKickoffStarted = true;
  batchRunning = true;
  sessionLeads = (pack.sessionLeads || []).map(hydrateLead);
  replaySessionLeadsToPanel();
  debugLog(
    "info",
    `Resuming after refresh — ${sessionLeads.length} lead(s) saved, continuing at search ${nextIndex + 1}/${pack.keywords.length}.`
  );
  postToPanel({
    type: "BATCH_RESUMED",
    current: nextIndex + 1,
    total: pack.keywords.length,
    leads: sessionLeads.length,
    reason: pack.reason || "resume",
  });

  try {
    try {
      await waitForSearchInput(45000);
    } catch (_) {
      debugLog("warn", "Maps search box not ready after refresh — waiting a bit more…");
      await sleep(3000);
      await waitForSearchInput(30000);
    }
    await runBatch({
      fromResume: true,
      keywords: pack.keywords,
      limit: pack.limit,
      getAll: pack.getAll,
      autoEnrich: pack.autoEnrich,
      combineBatchCsv: pack.combineBatchCsv,
      mapsRefreshEvery: pack.mapsRefreshEvery || pack.refreshEveryN || 0,
      resumeNextIndex: nextIndex,
    });
  } catch (e) {
    if (!plannedReload) {
      debugLog("error", `Resume failed: ${e?.message || e}`);
      postToPanel({ type: "BATCH_DONE", ok: false, error: String(e?.message || e) });
    }
  } finally {
    batchRunning = false;
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

async function postInitState(prefs) {
  const tabId = await getMyTabId();
  postToPanel({
    type: "INIT_STATE",
    minimized: prefs.minimized,
    verbose: prefs.verbose,
    mapsPageOrigin: window.location.origin,
    tabId,
  });
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
    await postInitState(prefs);
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
      loadSidebarPrefs().then(async (p) => {
        await postInitState(p);
        applyHostWidth(p.minimized);
        tryResumeSavedBatch().catch((e) => {
          debugLog("warn", "Resume check failed.", String(e?.message || e));
        });
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
      plannedReload = false;
      stopFreezeWatch();
      clearResumePack();
      chrome.runtime.sendMessage({ action: "REQUEST_STOP" });
      return;
    }

    if (d.type === "ENRICH_REQUEST") {
      const rows = sessionLeads.map((r, sessionIndex) => ({
        search_query: r.search_query || "",
        title: r.title || "",
        address: r.address || "",
        phone: r.phone || "",
        website_url: r.website_url || "",
        sessionIndex,
      }));
      postToPanel({ type: "ENRICH_PAYLOAD", rows });
      return;
    }

    if (d.type === "ENRICH_AUTO_DONE") {
      if (typeof enrichAutoWait === "function") {
        enrichAutoWait({ ok: !!d.ok, error: d.error || "", empty: !!d.empty });
      }
      return;
    }

    if (d.type === "ENRICH_ROW") {
      const idx = d.index;
      const email = d.email != null ? String(d.email) : "";
      if (typeof idx !== "number" || idx < 0 || idx >= sessionLeads.length) {
        postToPanel({
          type: "LOG",
          level: "warn",
          message: `Enrich: bad row index ${idx}`,
          ts: Date.now(),
        });
        return;
      }
      sessionLeads[idx].email = email;
      postToPanel({
        type: "LEADS_ROW_UPDATE",
        index: idx,
        count: sessionLeads.length,
        row: stripInternalLeadFields(sessionLeads[idx]),
      });
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
      if (!batchRunning) clearResumePack();
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
        .catch((e) => {
          debugLog("error", `Batch failed: ${e?.message || e}`);
          postToPanel({ type: "BATCH_DONE", ok: false, error: String(e?.message || e) });
        })
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
    if (message?.action === "PING") {
      nudgeSleeps();
      checkFreezeFromWatchdog();
      if (batchRunning) startTabKeepAliveAudio();
      sendResponse({
        ok: true,
        ts: Date.now(),
        hidden: document.hidden,
        batchRunning,
        tabId: myTabId,
      });
      return true;
    }
    return false;
  });
}

installUiBridge();
getMyTabId();
mountSidebar();

let loggedBackgroundRun = false;
document.addEventListener("visibilitychange", () => {
  nudgeSleeps();
  if (!batchRunning) {
    loggedBackgroundRun = false;
    return;
  }
  if (document.hidden) {
    if (!loggedBackgroundRun) {
      loggedBackgroundRun = true;
      debugLog("info", "This Maps tab is in the background — the queue on this tab keeps running (may be slower).");
    }
  } else {
    loggedBackgroundRun = false;
    startTabKeepAliveAudio();
  }
});
