// Background service worker for YouTube Connectivity & GGC Analyzer

const MAX_RECORDS = 1500;
const STALL_THRESHOLD_MS = 3500; // Requests taking >3.5s or failing around 5s
const COLLECTOR_URL = "http://127.0.0.1:18999/ingest";

// In-memory state synced to chrome.storage.local
let inFlight = new Map();
let tabVideoMap = new Map(); // tabId -> { videoId, title, url, updatedAt }
let cpnVideoMap = new Map(); // cpn -> { videoId, title }
let records = [];
let playerEvents = [];

// Load persisted records on startup
chrome.storage.local.get(["records", "playerEvents", "cpnVideoMap"], (res) => {
  if (Array.isArray(res.records)) records = res.records;
  if (Array.isArray(res.playerEvents)) playerEvents = res.playerEvents;
  if (res.cpnVideoMap && typeof res.cpnVideoMap === "object") {
    for (const [k, v] of Object.entries(res.cpnVideoMap)) {
      cpnVideoMap.set(k, v);
    }
  }
  updateBadge();
});

function parseTargetUrl(rawUrl, method) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname;
    const path = u.pathname;
    const sp = u.searchParams;

    const isVideoPlayback = host.endsWith(".googlevideo.com") && path.includes("/videoplayback");
    if (!isVideoPlayback) {
      return {
        kind: "youtube_AssetOrApi",
        host,
        path,
        isFakeProbe: false
      };
    }

    const expire = Number(sp.get("expire") || 0);
    const dur = Number(sp.get("dur") || 0);
    const itag = sp.get("itag") || null;
    const clientIp = sp.get("ip") || null;
    const id = sp.get("id") || null;
    const cpn = sp.get("cpn") || null;
    const rn = sp.get("rn") ? Number(sp.get("rn")) : null;
    const mn = sp.get("mn") || null;
    const ms = sp.get("ms") || null;
    const mm = sp.get("mm") || null;
    const mv = sp.get("mv") || null;
    const mvi = sp.get("mvi") || null;
    const pl = sp.get("pl") || null;
    const cm2 = sp.get("pcm2cms") || null;
    const fallbackCount = sp.get("fallback_count") ? Number(sp.get("fallback_count")) : 0;
    const redirectCounter = sp.get("redirect_counter") ? Number(sp.get("redirect_counter")) : 0;
    const cmsRedirect = sp.get("cms_redirect") === "yes";
    const sabr = sp.get("sabr") === "1";

    // Extract GGC / edge node info from hostname e.g. rr2---sn-8ph2xajvh-8v1s.googlevideo.com
    let rrNode = null;
    let snCluster = null;
    const m = host.match(/^(rr\d+)---(sn-[a-z0-9-]+)\.googlevideo\.com$/i) ||
              host.match(/^(rr\d+)\.(sn-[a-z0-9-]+)\.googlevideo\.com$/i);
    if (m) {
      rrNode = m[1];
      snCluster = m[2];
    }

    // Detect YouTube's fake anti-adblock canary probes:
    // Usually GET with expire > 3000000000 (year 2065+) or dur > 10000000 or gibberish mn= without sn-
    const isFakeProbe =
      expire > 2500000000 ||
      dur > 5000000 ||
      (mn !== null && !mn.includes("sn-"));

    let kind = "video_chunk";
    if (isFakeProbe) {
      kind = "anti_adblock_probe";
    } else if (cmsRedirect || fallbackCount > 0 || redirectCounter > 0) {
      kind = "video_chunk_fallback";
    }

    return {
      kind,
      host,
      path,
      rrNode,
      snCluster,
      isFakeProbe,
      expire,
      dur: dur || null,
      itag,
      clientIp,
      streamId: id,
      cpn,
      rn,
      mn,
      ms,
      mm,
      mv,
      mvi,
      pl,
      cm2,
      sabr,
      fallbackCount,
      redirectCounter,
      cmsRedirect,
      method
    };
  } catch (err) {
    return {
      kind: "unknown",
      host: "unknown",
      path: "",
      isFakeProbe: false
    };
  }
}

function resolveVideoContext(tabId, cpn) {
  if (cpn && cpnVideoMap.has(cpn)) {
    return cpnVideoMap.get(cpn);
  }
  if (tabId >= 0 && tabVideoMap.has(tabId)) {
    const ctx = tabVideoMap.get(tabId);
    if (cpn && ctx.videoId) {
      cpnVideoMap.set(cpn, { videoId: ctx.videoId, title: ctx.title });
    }
    return { videoId: ctx.videoId, title: ctx.title };
  }
  return { videoId: null, title: null };
}

function classifyOutcome(entry) {
  if (entry.parsed.isFakeProbe) {
    return "IGNORED_FAKE_PROBE";
  }
  if (entry.error) {
    if (entry.durationMs >= 4500) {
      return "STALL_5S_TIMEOUT";
    }
    if (
      entry.error.includes("ERR_ADDRESS_UNREACHABLE") ||
      entry.error.includes("ERR_CONNECTION_REFUSED") ||
      entry.error.includes("ERR_INVALID_HANDLE") ||
      entry.durationMs < 100
    ) {
      return "FAST_REJECT_ROUTE";
    }
    return "NETWORK_ERROR";
  }
  if (entry.statusCode >= 300 && entry.statusCode < 400) {
    return "REDIRECT";
  }
  if (entry.ttfbMs && entry.ttfbMs >= STALL_THRESHOLD_MS) {
    return "SLOW_TTFB_STALL";
  }
  if (entry.durationMs >= 4800 && entry.statusCode === 200) {
    return "SLOW_CHUNK_TRANSFER";
  }
  if (entry.statusCode >= 200 && entry.statusCode < 300) {
    return entry.parsed.fallbackCount > 0 ? "OK_FALLBACK" : "OK_PRIMARY";
  }
  return `HTTP_${entry.statusCode || "UNKNOWN"}`;
}

let saveTimer = null;
function scheduleSave() {
  updateBadge();
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const cpnObj = Object.fromEntries(cpnVideoMap.entries());
    chrome.storage.local.set({
      records: records.slice(-MAX_RECORDS),
      playerEvents: playerEvents.slice(-500),
      cpnVideoMap: cpnObj
    });
  }, 500);
}

function sendToLocalCollector(payload) {
  // Optional: silently mirror to local CLI collector if running on 127.0.0.1:18999
  fetch(COLLECTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

function recordCompletedEntry(entry) {
  entry.outcome = classifyOutcome(entry);
  records.push(entry);
  if (records.length > MAX_RECORDS) {
    records = records.slice(-MAX_RECORDS);
  }
  scheduleSave();
  sendToLocalCollector({ type: "network_request", data: entry });
}

function updateBadge() {
  // Count real stalls / network errors (excluding fake probes and intentional fast-reject routes)
  const recentIssues = records.filter(
    (r) =>
      r.outcome === "STALL_5S_TIMEOUT" ||
      r.outcome === "NETWORK_ERROR" ||
      r.outcome === "SLOW_TTFB_STALL"
  ).length;

  if (recentIssues > 0) {
    chrome.action.setBadgeText({ text: String(recentIssues) });
    chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// Track requests of interest
const URL_FILTER = {
  urls: [
    "*://*.googlevideo.com/*",
    "*://www.youtube.com/youtubei/v1/player*",
    "*://www.youtube.com/watch*",
    "*://www.youtube.com/*"
  ]
};

function shouldTrackUrl(url, type) {
  if (url.includes(".googlevideo.com/videoplayback")) return true;
  if (url.includes("www.youtube.com/youtubei/v1/player")) return true;
  if (type === "main_frame" && url.includes("youtube.com")) return true;
  return false;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!shouldTrackUrl(details.url, details.type)) return;
    const parsed = parseTargetUrl(details.url, details.method);
    const videoCtx = resolveVideoContext(details.tabId, parsed.cpn);

    inFlight.set(details.requestId, {
      requestId: details.requestId,
      tabId: details.tabId,
      type: details.type,
      method: details.method,
      url: details.url,
      startedAtIso: new Date(details.timeStamp).toISOString(),
      startTimeMs: details.timeStamp,
      ttfbMs: null,
      durationMs: null,
      serverIp: null,
      fromCache: false,
      statusCode: null,
      statusLine: null,
      error: null,
      redirectUrl: null,
      videoId: videoCtx.videoId,
      videoTitle: videoCtx.title,
      parsed
    });
  },
  URL_FILTER
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const item = inFlight.get(details.requestId);
    if (!item) return;
    item.ttfbMs = Math.round(details.timeStamp - item.startTimeMs);
    item.serverIp = details.ip || item.serverIp;
    item.fromCache = Boolean(details.fromCache);
    item.statusCode = details.statusCode;
    item.statusLine = details.statusLine || null;
  },
  URL_FILTER
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    const item = inFlight.get(details.requestId);
    if (!item) return;
    item.durationMs = Math.round(details.timeStamp - item.startTimeMs);
    item.serverIp = details.ip || item.serverIp;
    item.statusCode = details.statusCode;
    item.redirectUrl = details.redirectUrl;

    // Record the redirect hop as its own entry so we can see n8vs -> aj5goc redirects
    const redirectCopy = { ...item };
    recordCompletedEntry(redirectCopy);

    // Reset start timer for the redirected target
    const newParsed = parseTargetUrl(details.redirectUrl, item.method);
    item.url = details.redirectUrl;
    item.parsed = newParsed;
    item.startTimeMs = details.timeStamp;
    item.ttfbMs = null;
    item.serverIp = null;
    item.redirectUrl = null;
  },
  URL_FILTER
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const item = inFlight.get(details.requestId);
    if (!item) return;
    inFlight.delete(details.requestId);

    item.durationMs = Math.round(details.timeStamp - item.startTimeMs);
    if (item.ttfbMs === null) item.ttfbMs = item.durationMs;
    item.serverIp = details.ip || item.serverIp;
    item.fromCache = Boolean(details.fromCache);
    item.statusCode = details.statusCode;
    item.statusLine = details.statusLine || item.statusLine;

    const ctx = resolveVideoContext(item.tabId, item.parsed.cpn);
    if (!item.videoId && ctx.videoId) item.videoId = ctx.videoId;
    if (!item.videoTitle && ctx.title) item.videoTitle = ctx.title;

    recordCompletedEntry(item);
  },
  URL_FILTER
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const item = inFlight.get(details.requestId);
    if (!item) return;
    inFlight.delete(details.requestId);

    item.durationMs = Math.round(details.timeStamp - item.startTimeMs);
    item.serverIp = details.ip || item.serverIp;
    item.error = details.error || "UNKNOWN_ERROR";

    const ctx = resolveVideoContext(item.tabId, item.parsed.cpn);
    if (!item.videoId && ctx.videoId) item.videoId = ctx.videoId;
    if (!item.videoTitle && ctx.title) item.videoTitle = ctx.title;

    recordCompletedEntry(item);
  },
  URL_FILTER
);

// Sweep any hung in-flight requests after 15s so we can see requests that Chrome aborts silently
setInterval(() => {
  const now = Date.now();
  for (const [reqId, item] of inFlight.entries()) {
    const elapsed = Math.round(now - item.startTimeMs);
    if (elapsed > 15000) {
      inFlight.delete(reqId);
      item.durationMs = elapsed;
      item.error = "HUNG_OVER_15S_NO_COMPLETION";
      recordCompletedEntry(item);
    }
  }
}, 3000);

// Messages from content.js and popup.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "YT_VIDEO_META" && sender.tab) {
    const tabId = sender.tab.id;
    tabVideoMap.set(tabId, {
      videoId: msg.videoId,
      title: msg.title,
      url: msg.url,
      updatedAt: new Date().toISOString()
    });
    if (msg.cpn && msg.videoId) {
      cpnVideoMap.set(msg.cpn, { videoId: msg.videoId, title: msg.title });
    }
    // Backfill recent records from this tab that missed videoId
    for (let i = records.length - 1; i >= 0 && i >= records.length - 50; i--) {
      if (records[i].tabId === tabId && !records[i].videoId) {
        records[i].videoId = msg.videoId;
        records[i].videoTitle = msg.title;
      }
    }
    scheduleSave();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "YT_PLAYER_EVENT") {
    const ev = {
      timestampIso: new Date().toISOString(),
      tabId: sender.tab ? sender.tab.id : null,
      ...msg.payload
    };
    playerEvents.push(ev);
    if (playerEvents.length > 500) {
      playerEvents = playerEvents.slice(-500);
    }
    scheduleSave();
    sendToLocalCollector({ type: "player_event", data: ev });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_STATE") {
    sendResponse({
      records,
      playerEvents,
      inFlight: Array.from(inFlight.values()).map((r) => ({
        ...r,
        elapsedMs: Math.round(Date.now() - r.startTimeMs)
      }))
    });
    return true;
  }

  if (msg.type === "CLEAR_STATE") {
    records = [];
    playerEvents = [];
    inFlight.clear();
    chrome.storage.local.set({ records: [], playerEvents: [] }, () => {
      updateBadge();
      sendResponse({ ok: true });
    });
    return true;
  }
});
