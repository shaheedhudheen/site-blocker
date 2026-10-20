// Blocked page: shows which site was blocked, why, and offers to unblock it.
//
// The redirect adds the original URL in "?url=..." plus optional "mode"
// (permanent | timed | focus) and "until" (timestamp) parameters. The url
// value can be substituted raw (so URLSearchParams would cut it off at the
// first "&") or percent-encoded, so handle both.
//
// The page also watches the service worker: when a timer runs out or a focus
// session moves into its break, the site becomes reachable again and this
// page sends the user straight there instead of making them reload manually.

const search = location.search;

function readUrlParam() {
  const byParams = new URLSearchParams(search).get("url");
  // The original url is substituted raw and is always the last parameter, so
  // it may contain "&" that URLSearchParams would treat as a separator. Find
  // the real marker and take everything after it.
  let tail = null;
  const ampMarker = search.indexOf("&url=");
  if (ampMarker >= 0) {
    tail = search.slice(ampMarker + "&url=".length);
  } else if (search.startsWith("?url=")) {
    tail = search.slice("?url=".length);
  }
  if (tail) {
    if (/^https?:\/\//i.test(tail)) return tail; // raw substitution
    try {
      const decoded = decodeURIComponent(tail);
      if (/^https?:\/\//i.test(decoded)) return decoded; // encoded substitution
    } catch {
      // not valid percent-encoding; fall through to the parsed value
    }
  }
  return byParams;
}

const params = new URLSearchParams(search);
const rawUrl = readUrlParam();
const rawSite = params.get("site"); // domain only, if that's all we have
const initialMode = params.get("mode") || "permanent";
const initialUntil = Number(params.get("until")) || 0;

let targetUrl = null;
let domain = null;

if (rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      targetUrl = url.href;
      domain = url.hostname;
    }
  } catch {
    // ignore malformed url param
  }
}
if (!domain && rawSite) {
  domain = rawSite.toLowerCase().replace(/^www\./, "");
}

// A fragment in the original URL (#section) is carried by the browser as the
// blocked page's own fragment, so put it back on the target URL.
if (targetUrl && !targetUrl.includes("#") && location.hash) {
  targetUrl += location.hash;
}

const titleEl = document.getElementById("title");
const siteName = document.getElementById("siteName");
const countdownEl = document.getElementById("countdown");
const hintEl = document.getElementById("hint");
const unblockBtn = document.getElementById("unblock");
const goBackBtn = document.getElementById("goBack");

// Live state, refreshed from the service worker.
let mode = initialMode;
let until = initialUntil;
let released = false;

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

if (domain) {
  siteName.textContent = domain;
  document.title = domain + " is blocked";
} else {
  siteName.textContent = "This site";
  document.title = "Site blocked";
}

function applyMode() {
  if (mode === "focus") {
    titleEl.textContent = "Site blocked";
    hintEl.textContent = "This site is blocked for your focus session.";
    unblockBtn.hidden = true;
  } else if (mode === "timed") {
    titleEl.textContent = "Site blocked temporarily";
    hintEl.textContent = "You set a timer for this site. It unlocks when the timer runs out.";
    unblockBtn.hidden = false;
    unblockBtn.textContent = "Cancel timer and visit";
  } else {
    titleEl.textContent = "Site blocked";
    hintEl.textContent = "You added this site to Site Blocker, so it can't be opened.";
    unblockBtn.hidden = false;
    unblockBtn.textContent = "Unblock and visit";
  }
}
applyMode();

function updateCountdown() {
  if (released) return;
  if (!until) {
    countdownEl.hidden = true;
    return;
  }
  const remaining = until - Date.now();
  if (remaining <= 0) {
    countdownEl.hidden = true;
    return;
  }
  countdownEl.hidden = false;
  countdownEl.textContent =
    (mode === "focus" ? "Unlocks in " : "Unblocks in ") + formatDuration(remaining);
}

// Ask the service worker whether the site is still blocked. When the answer
// is no the block is over (timer ran out, focus break started, site removed)
// and we send the user to the site they wanted.
async function checkState() {
  if (released || !domain) return;
  let state = null;
  try {
    state = await chrome.runtime.sendMessage({ type: "getBlockState", host: domain });
  } catch {
    return; // service worker unavailable; try again on the next tick
  }
  if (!state) return;

  if (!state.blocked) {
    released = true;
    // The block is gone - go to the site (or back where we came from).
    if (targetUrl) {
      location.replace(targetUrl);
    } else {
      location.replace("https://" + domain + "/");
    }
    return;
  }

  if (state.mode !== mode) {
    mode = state.mode;
    applyMode();
  }
  if (state.until !== until) {
    until = state.until;
  }
  updateCountdown();
}

function startWatching() {
  updateCountdown();
  setInterval(() => {
    updateCountdown();
    checkState();
  }, 1000);
  // Also check right away in case the block was lifted while we loaded.
  checkState();
}

startWatching();

unblockBtn.addEventListener("click", async () => {
  const { blockedSites = [], timedBlocks = {} } = await chrome.storage.sync.get({
    blockedSites: [],
    timedBlocks: {},
  });
  const host = (domain || "").toLowerCase();
  const match = blockedSites.find((s) => host === s || host.endsWith("." + s));
  const timedMatch = Object.keys(timedBlocks).find((s) => host === s || host.endsWith("." + s));

  if (match) {
    await chrome.storage.sync.set({ blockedSites: blockedSites.filter((s) => s !== match) });
  } else if (timedMatch) {
    const next = { ...timedBlocks };
    delete next[timedMatch];
    await chrome.storage.sync.set({ timedBlocks: next });
  }

  // Rebuild rules immediately and wait for them to be applied, otherwise the
  // navigation below can be caught by the rule we are trying to remove.
  try {
    await chrome.runtime.sendMessage({ type: "syncNow" });
  } catch {
    // storage.onChanged also triggers a sync; retry the navigation anyway
  }
  released = true;
  if (targetUrl) {
    location.replace(targetUrl);
  } else if (domain) {
    location.replace("https://" + domain + "/");
  } else {
    history.back();
  }
});

goBackBtn.addEventListener("click", async () => {
  if (history.length > 1) {
    history.back();
    return;
  }
  // Nothing to go back to: close the tab we opened the blocked site in.
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    // fall through
  }
  location.replace("about:blank");
});
